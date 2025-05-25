import boto3
from botocore.config import Config
import os
import uuid
from dotenv import load_dotenv
from typing import Union, List, Dict, Any, Optional
import logging
from fastapi import FastAPI, Request, status, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from pathlib import Path
import datetime
import io
import csv
import pandas as pd
from scipy import stats as scipy_stats


load_dotenv()

app = FastAPI()
logger = logging.getLogger("uvicorn")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
DYNAMO_TABLE_FILES = os.getenv("DYNAMO_TABLE")
BUCKET_NAME = os.getenv("BUCKET")

my_config = Config(region_name=AWS_REGION)
dynamodb_resource = boto3.resource('dynamodb', config=my_config)
files_table = dynamodb_resource.Table(DYNAMO_TABLE_FILES)
s3_client = boto3.client('s3', config=Config(signature_version='s3v4', region_name=AWS_REGION))


class FileInitiateUploadRequest(BaseModel):
    filename: str = Field(..., examples=["mydata.csv"])
    filetype: str = Field(..., examples=["text/csv"])

class FileInitiateUploadResponse(BaseModel):
    upload_url: str
    s3_object_key: str
    file_id: str

class FileConfirmUploadRequest(BaseModel):
    file_id: str
    s3_object_key: str
    original_filename: str
    file_type: str
    file_size: Union[int, None] = None

class FileMetadataResponse(BaseModel):
    user: str
    file_id: str
    original_filename: str
    s3_object_key: str
    file_type: str
    upload_timestamp: str
    file_size: Union[int, None] = None
    status: str = "uploaded"
    columnHeaders: Optional[List[str]] = None
    rowCount: Optional[int] = None
    columnCount: Optional[int] = None
    processingStatus: Optional[str] = None
    processedTimestamp: Optional[str] = None


class FileDownloadUrlResponse(BaseModel):
    download_url: str
    s3_object_key: str

# NOUVEAUX MODÈLES POUR LES STATISTIQUES ET GRAPHIQUES
class DescriptiveStatsResponse(BaseModel):
    variable_name: str
    count: int
    mean: Optional[float] = None
    median: Optional[float] = None
    std_dev: Optional[float] = None
    min_val: Optional[float] = None
    max_val: Optional[float] = None
    q1: Optional[float] = None
    q3: Optional[float] = None
    missing_values: int
    data_type_detected: str # 'numeric', 'categorical', 'mixed'
    unique_values_count: Optional[int] = None
    top_frequencies: Optional[List[Dict[str, Any]]] = None # Pour catégoriel [{value: count}, ...]


class BoxplotDataResponse(BaseModel):
    variable_name: str
    min_val: float
    q1: float
    median: float
    q3: float
    max_val: float
    outliers: List[float] = [] # Optionnel, si on les calcule


def generate_s3_presigned_url(bucket_name: str, object_key: str, client_method: str = 'put_object', expires_in: int = 3600, content_type: Union[str, None] = None):
    params = {'Bucket': bucket_name, 'Key': object_key}
    if content_type and client_method == 'put_object':
        params['ContentType'] = content_type
    try:
        url = s3_client.generate_presigned_url(ClientMethod=client_method, Params=params, ExpiresIn=expires_in)
        return url
    except ClientError as e:
        logger.error(f"S3 ClientError generating presigned URL for {object_key} ({client_method}): {e}", exc_info=True)
        return None
    except Exception as e:
        logger.error(f"Unexpected error generating presigned URL for {object_key}: {e}", exc_info=True)
        return None

async def get_dataframe_from_s3(user: str, file_id: str) -> pd.DataFrame:
    """Télécharge un fichier depuis S3 et le charge dans un DataFrame pandas."""
    try:
        db_response = files_table.get_item(Key={'user': user, 'id': file_id})
        item = db_response.get('Item')
        if not item:
            logger.warning(f"File metadata not found in DynamoDB for user '{user}', file_id '{file_id}'.")
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File metadata not found.")
        
        s3_object_key = item.get('s3_object_key')
        file_type_from_db = item.get('file_type', '').lower()
        original_filename_from_db = item.get('original_filename', '').lower()

        if not s3_object_key:
            logger.error(f"S3 object key missing in metadata for user '{user}', file_id '{file_id}'. Item: {item}")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="S3 object key missing in metadata.")

        logger.info(f"Fetching S3 object '{s3_object_key}' for user '{user}', file_id '{file_id}'. Type: '{file_type_from_db}', Filename: '{original_filename_from_db}'")

        s3_response = s3_client.get_object(Bucket=BUCKET_NAME, Key=s3_object_key)
        file_content_bytes = s3_response['Body'].read() # Lire le contenu une seule fois en bytes

        df = None
        is_csv_type = 'csv' in file_type_from_db or original_filename_from_db.endswith('.csv')
        is_excel_type = 'excel' in file_type_from_db or 'spreadsheetml' in file_type_from_db or \
                        original_filename_from_db.endswith('.xlsx') or original_filename_from_db.endswith('.xls')

        if is_csv_type:
            logger.info(f"Processing as CSV: {s3_object_key}")
            # Tenter de décoder en string pour le sniffer et pour une première inspection
            try:
                file_content_str = file_content_bytes.decode('utf-8-sig') # Gère le BOM
            except UnicodeDecodeError:
                logger.warning(f"UTF-8-SIG decode failed for {s3_object_key}, trying with 'latin-1'")
                try:
                    file_content_str = file_content_bytes.decode('latin-1')
                except UnicodeDecodeError as ude:
                    logger.error(f"Could not decode CSV content for {s3_object_key}: {ude}")
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot decode CSV file content.")

            detected_delimiter = ',' # Défaut
            try:
                # Utiliser le sniffer sur un échantillon du fichier
                sample_for_sniffing = "\n".join(file_content_str.splitlines()[:20]) # Sniff sur les 20 premières lignes
                dialect = csv.Sniffer().sniff(sample_for_sniffing)
                detected_delimiter = dialect.delimiter
                logger.info(f"CSV Sniffer detected delimiter: '{detected_delimiter}' for {s3_object_key}")
            except csv.Error as sniff_error:
                logger.warning(f"CSV Sniffer failed for {s3_object_key} ('{sniff_error}'). Checking for common delimiters.")
                # Si le sniffer échoue, on peut essayer une heuristique simple
                if file_content_str.splitlines()[0].count(';') > file_content_str.splitlines()[0].count(','):
                    detected_delimiter = ';'
                    logger.info(f"Sniffer failed, heuristic suggests delimiter: ';' for {s3_object_key}")
                else:
                    logger.info(f"Sniffer failed, heuristic suggests delimiter: ',' for {s3_object_key}")
            
            try:
                # Lire le CSV avec le délimiteur détecté (ou le délimiteur par défaut)
                # On utilise file_content_bytes car pandas peut gérer les bytes directement
                df = pd.read_csv(io.BytesIO(file_content_bytes), delimiter=detected_delimiter, header='infer', skipinitialspace=True)
                logger.info(f"Successfully parsed CSV with delimiter '{detected_delimiter}'. Columns: {df.columns.tolist()}")

                # Vérification supplémentaire: si on a une seule colonne et que le nom contient des délimiteurs non utilisés
                if df.shape[1] == 1:
                    col_name = df.columns[0]
                    if detected_delimiter == ',' and ';' in col_name:
                        logger.warning(f"CSV parsed with ',' but found ';' in single column name. Trying with ';'. Column: {col_name}")
                        df = pd.read_csv(io.BytesIO(file_content_bytes), delimiter=';', header='infer', skipinitialspace=True)
                    elif detected_delimiter == ';' and ',' in col_name:
                         logger.warning(f"CSV parsed with ';' but found ',' in single column name. Trying with ','. Column: {col_name}")
                         df = pd.read_csv(io.BytesIO(file_content_bytes), delimiter=',', header='infer', skipinitialspace=True)
                
            except Exception as e_csv:
                logger.error(f"Error parsing CSV {s3_object_key} with delimiter '{detected_delimiter}': {e_csv}", exc_info=True)
                # Tenter un dernier fallback avec un délimiteur commun si l'erreur persiste
                fallback_delimiter = ';' if detected_delimiter == ',' else ','
                try:
                    logger.info(f"Attempting fallback parse with delimiter '{fallback_delimiter}' for {s3_object_key}")
                    df = pd.read_csv(io.BytesIO(file_content_bytes), delimiter=fallback_delimiter, header='infer', skipinitialspace=True)
                    logger.info(f"Successfully parsed CSV with fallback delimiter '{fallback_delimiter}'. Columns: {df.columns.tolist()}")
                except Exception as e_fallback:
                    logger.error(f"Fallback parse also failed for {s3_object_key} with delimiter '{fallback_delimiter}': {e_fallback}", exc_info=True)
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Could not parse CSV file. Tried delimiters: '{detected_delimiter}', '{fallback_delimiter}'. Error: {str(e_csv)}")

        elif is_excel_type:
            logger.info(f"Processing as Excel: {s3_object_key}")
            try:
                df = pd.read_excel(io.BytesIO(file_content_bytes)) # Pandas gère les bytes pour Excel
            except Exception as e_excel:
                logger.error(f"Error parsing Excel file {s3_object_key}: {e_excel}", exc_info=True)
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Could not parse Excel file: {str(e_excel)}")
        else:
            logger.warning(f"Unsupported file type for S3 object '{s3_object_key}'. Type: '{file_type_from_db}', Filename: '{original_filename_from_db}'")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Unsupported file type: '{file_type_from_db or original_filename_from_db}'")
        
        if df is None or df.empty:
            logger.warning(f"Parsed DataFrame is empty for S3 object '{s3_object_key}'.")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Parsed DataFrame is empty. File might be empty or delimiter/format issue.")
        
        logger.info(f"DataFrame for S3 object '{s3_object_key}' loaded. Final columns: {df.columns.tolist()}")
        df.columns = df.columns.str.strip()
        return df

    except ClientError as e_boto: 
        logger.error(f"AWS ClientError for file_id '{file_id}', user '{user}': {e_boto}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error accessing file data: {str(e_boto)}")
    except pd.errors.EmptyDataError: 
        logger.warning(f"Pandas EmptyDataError for file_id '{file_id}', user '{user}'. S3 object likely empty.")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The file is empty or unparseable by the backend.")
    except HTTPException: 
        raise
    except Exception as e_general: 
        logger.error(f"Unexpected error processing file_id '{file_id}' for user '{user}': {e_general}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Could not process file: {str(e_general)}")



@app.post("/files/initiate-upload", response_model=FileInitiateUploadResponse, status_code=status.HTTP_200_OK)
async def initiate_file_upload(
    payload: FileInitiateUploadRequest,
    authorization: Union[str, None] = Header(default=None)
):
    user = authorization
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not authenticated")
    if not BUCKET_NAME:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="S3 Bucket not configured")

    file_id = str(uuid.uuid4())
    unique_file_suffix = Path(payload.filename).suffix
    s3_filename = f"{uuid.uuid4()}{unique_file_suffix}" 
    s3_object_key = f"user_uploads/{user}/{file_id}/{s3_filename}"

    upload_url = generate_s3_presigned_url(
        BUCKET_NAME,
        s3_object_key,
        client_method='put_object',
        content_type=payload.filetype
    )

    if not upload_url:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not generate upload URL")

    logger.info(f"Initiated upload for user {user}, file_id {file_id}, S3 key {s3_object_key}")
    return FileInitiateUploadResponse(upload_url=upload_url, s3_object_key=s3_object_key, file_id=file_id)


@app.post("/files/confirm-upload", response_model=FileMetadataResponse, status_code=status.HTTP_201_CREATED)
async def confirm_file_upload(
    payload: FileConfirmUploadRequest,
    authorization: Union[str, None] = Header(default=None)
):
    user = authorization
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not authenticated")

    timestamp = datetime.datetime.utcnow().isoformat()
    
    # Étape 1: Vérifier si l'objet existe réellement sur S3
    try:
        s3_client.head_object(Bucket=BUCKET_NAME, Key=payload.s3_object_key)
    except ClientError as e:
        if e.response['Error']['Code'] == '404':
            logger.error(f"S3 object not found for confirmation: {payload.s3_object_key} for user {user}, file_id {payload.file_id}")
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Uploaded file not found on S3.")
        logger.error(f"S3 ClientError checking object {payload.s3_object_key} for user {user}, file_id {payload.file_id}: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Error verifying file on S3.")

    item_for_db = {
        'user': user,
        'id': payload.file_id,
        'original_filename': payload.original_filename,
        's3_object_key': payload.s3_object_key,
        'file_type': payload.file_type,
        'upload_timestamp': timestamp,
        'file_size': payload.file_size,
        'status': 'uploaded',
        'processingStatus': 'pending_lambda'
    }
    
    logger.debug(f"Item to be put in DynamoDB for user {user}, file_id from payload {payload.file_id}: {item_for_db}")

    try:
        files_table.put_item(Item=item_for_db)
        logger.info(f"Successfully stored metadata in DynamoDB for user {user}, file_id from payload {payload.file_id} (DynamoDB 'id': {item_for_db['id']})")
        
        response_data = {
            'user': item_for_db['user'],
            'file_id': item_for_db['id'], # Mappage de la clé 'id' de la DB vers 'file_id' pour la réponse
            'original_filename': item_for_db['original_filename'],
            's3_object_key': item_for_db['s3_object_key'],
            'file_type': item_for_db['file_type'],
            'upload_timestamp': item_for_db['upload_timestamp'],
            'file_size': item_for_db.get('file_size'),
            'status': item_for_db.get('status', 'uploaded'),
            'columnHeaders': item_for_db.get('columnHeaders'), 
            'rowCount': item_for_db.get('rowCount'),
            'columnCount': item_for_db.get('columnCount'),
            'processingStatus': item_for_db.get('processingStatus'),
            'processedTimestamp': item_for_db.get('processedTimestamp')
        }
        
        return FileMetadataResponse(**response_data)

    except ClientError as e:
        logger.error(f"DynamoDB ClientError during put_item for user {user}, file_id from payload {payload.file_id} (DynamoDB 'id': {item_for_db['id']}): {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to record file metadata in database: {e.response['Error']['Message']}")
    except Exception as e:
        logger.error(f"Unexpected error during file metadata storage for user {user}, file_id from payload {payload.file_id} (DynamoDB 'id': {item_for_db['id']}): {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="An unexpected internal server error occurred while storing file metadata.")

@app.get("/files", response_model=List[FileMetadataResponse])
async def get_user_files(authorization: Union[str, None] = Header(default=None)):
    user = authorization
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not authenticated")

    logger.info(f"Fetching files for user: '{user}'")
    try:
        response = files_table.query(
            KeyConditionExpression=Key('user').eq(user)
        )
        items_from_db = response.get('Items', [])
        sorted_items_from_db = sorted(items_from_db, key=lambda x: x.get('upload_timestamp', ''), reverse=True)
        
        logger.debug(f"Items retrieved from DynamoDB for user {user}: {sorted_items_from_db[:2]}") 
        response_items = []
        for item_db in sorted_items_from_db:

            data_for_response_model = {
                'user': item_db.get('user'),
                'file_id': item_db.get('id'),  # <--- MAPPAGE CRUCIAL ICI
                'original_filename': item_db.get('original_filename'),
                's3_object_key': item_db.get('s3_object_key'),
                'file_type': item_db.get('file_type'),
                'upload_timestamp': item_db.get('upload_timestamp'),
                'file_size': item_db.get('file_size'), # Pydantic gère Decimal vers int/float si nécessaire ou vous pouvez caster
                'status': item_db.get('status'),
                'columnHeaders': item_db.get('columnHeaders'),
                'rowCount': item_db.get('rowCount'),
                'columnCount': item_db.get('columnCount'),
                'processingStatus': item_db.get('processingStatus'),
                'processedTimestamp': item_db.get('processedTimestamp')
            }

            response_items.append(FileMetadataResponse(**data_for_response_model))
            
        logger.info(f"DynamoDB Query returned {len(response_items)} files for user {user}.")
        return response_items

    except ClientError as e:
        logger.error(f"DynamoDB ClientError fetching files for user {user}: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Database error: {e.response['Error']['Message']}")
    except pydantic_core._pydantic_core.ValidationError as e:
        logger.error(f"Pydantic ValidationError fetching files for user {user}: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Data validation error: {str(e)}")
    except Exception as e:
        logger.error(f"!!! UNEXPECTED EXCEPTION fetching files for user {user}: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error during file retrieval")


@app.get("/files/{file_id}/download-url", response_model=FileDownloadUrlResponse)
async def get_file_download_url_endpoint( # Renommé pour éviter conflit avec la fonction helper
    file_id: str,
    authorization: Union[str, None] = Header(default=None)
):
    user = authorization
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not authenticated")
    if not BUCKET_NAME:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="S3 Bucket not configured")
    try:
        response = files_table.get_item(Key={'user': user, 'file_id': file_id})
        item = response.get('Item')
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found for this user.")
        s3_object_key = item.get('s3_object_key')
        if not s3_object_key:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="File record is incomplete.")
        download_url_val = generate_s3_presigned_url(BUCKET_NAME, s3_object_key, client_method='get_object')
        if not download_url_val:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not generate download URL")
        return FileDownloadUrlResponse(download_url=download_url_val, s3_object_key=s3_object_key)
    except ClientError as e:
        raise HTTPException(status_code=500, detail=f"Database error: {e.response['Error']['Message']}")
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail="Internal server error")



@app.get("/files/{file_id}/statistics/{variable_name}", response_model=DescriptiveStatsResponse)
async def get_file_statistics(
    file_id: str,
    variable_name: str,
    authorization: Union[str, None] = Header(default=None)
):
    user = authorization
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not authenticated")

    df = await get_dataframe_from_s3(user, file_id)
    
    if variable_name not in df.columns:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Variable '{variable_name}' not found in the file.")

    column_data = df[variable_name].dropna()
    total_rows_in_df = len(df)
    valid_count = len(column_data)
    missing_values = total_rows_in_df - valid_count
    
    stats = {
        "variable_name": variable_name,
        "count": valid_count,
        "missing_values": missing_values,
    }

    # Détection du type de données
    if pd.api.types.is_numeric_dtype(column_data) and valid_count > 0:
        stats["data_type_detected"] = "numeric"
        stats["mean"] = column_data.mean()
        stats["median"] = column_data.median()
        stats["std_dev"] = column_data.std()
        stats["min_val"] = column_data.min()
        stats["max_val"] = column_data.max()
        # Utiliser scipy pour des quartiles plus robustes, pandas utilise une interpolation par défaut.
        if valid_count >= 4 : # Besoin d'assez de données pour les quartiles
            stats["q1"] = column_data.quantile(0.25) # Alternative: scipy_stats.scoreatpercentile(column_data, 25)
            stats["q3"] = column_data.quantile(0.75) # Alternative: scipy_stats.scoreatpercentile(column_data, 75)
        else:
            stats["q1"] = None
            stats["q3"] = None
        stats["unique_values_count"] = column_data.nunique()

    elif valid_count > 0 : # Si non numérique ou mixte, traiter comme catégoriel/texte
        stats["data_type_detected"] = "categorical" if pd.api.types.is_object_dtype(column_data) or pd.api.types.is_string_dtype(column_data) else "mixed"
        stats["unique_values_count"] = column_data.nunique()
        top_freq = column_data.value_counts().nlargest(10) # Les 10 plus fréquentes
        stats["top_frequencies"] = [{"value": idx, "count": val} for idx, val in top_freq.items()]
    else: # Colonne vide après dropna
        stats["data_type_detected"] = "empty"
        stats["unique_values_count"] = 0


    return DescriptiveStatsResponse(**stats)


@app.get("/files/{file_id}/graph-data/boxplot/{variable_name}", response_model=BoxplotDataResponse)
async def get_boxplot_data(
    file_id: str,
    variable_name: str,
    authorization: Union[str, None] = Header(default=None)
):
    user = authorization
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not authenticated")

    df = await get_dataframe_from_s3(user, file_id)

    if variable_name not in df.columns:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Variable '{variable_name}' not found in the file.")

    column_data = df[variable_name].dropna()

    if not pd.api.types.is_numeric_dtype(column_data) or column_data.empty:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Variable '{variable_name}' is not numeric or is empty, cannot generate boxplot data.")

    # Calcul des statistiques pour le boxplot
    min_val = float(column_data.min())
    q1 = float(column_data.quantile(0.25))
    median = float(column_data.median())
    q3 = float(column_data.quantile(0.75))
    max_val = float(column_data.max())

    # Calcul des outliers (exemple simple, peut être affiné)
    iqr = q3 - q1
    lower_bound = q1 - 1.5 * iqr
    upper_bound = q3 + 1.5 * iqr
    
    outliers = column_data[(column_data < lower_bound) | (column_data > upper_bound)].tolist()

    return BoxplotDataResponse(
        variable_name=variable_name,
        min_val=min_val, # Ou la plus petite valeur dans lower_bound si on veut afficher les moustaches correctement
        q1=q1,
        median=median,
        q3=q3,
        max_val=max_val, # Ou la plus grande valeur dans upper_bound
        outliers=outliers # Laisser la bibliothèque de graphiques gérer l'affichage des outliers
    )


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="debug")