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

# NOUVEAUX IMPORTS POUR LE TRAITEMENT DES DONNÉES
import pandas as pd
from scipy import stats as scipy_stats # Pour les quartiles et autres


load_dotenv()

app = FastAPI()
logger = logging.getLogger("uvicorn")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # En production, spécifiez vos domaines React
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ... (Gestion des erreurs et configuration AWS existantes restent les mêmes) ...
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
DYNAMO_TABLE_FILES = os.getenv("DYNAMO_TABLE", "MyFilesTable")
BUCKET_NAME = os.getenv("BUCKET")

my_config = Config(region_name=AWS_REGION)
dynamodb_resource = boto3.resource('dynamodb', config=my_config)
files_table = dynamodb_resource.Table(DYNAMO_TABLE_FILES)
s3_client = boto3.client('s3', config=Config(signature_version='s3v4', region_name=AWS_REGION))


# --- Pydantic Models (les modèles existants restent) ---
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
    # Ajout des champs que la Lambda pourrait remplir
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


# --- Helper Functions (generate_s3_presigned_url reste) ---
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
        db_response = files_table.get_item(Key={'user': user, 'file_id': file_id})
        item = db_response.get('Item')
        if not item:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File metadata not found.")
        
        s3_object_key = item.get('s3_object_key')
        file_type = item.get('file_type', '').lower()
        original_filename = item.get('original_filename', '').lower()

        if not s3_object_key:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="S3 object key missing in metadata.")

        s3_response = s3_client.get_object(Bucket=BUCKET_NAME, Key=s3_object_key)
        file_content = s3_response['Body'].read()

        df = None
        if 'csv' in file_type or original_filename.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(file_content))
        elif 'excel' in file_type or 'spreadsheetml' in file_type or \
             original_filename.endswith('.xlsx') or original_filename.endswith('.xls'):
            df = pd.read_excel(io.BytesIO(file_content))
        else:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported file type for processing.")
        
        return df
    except ClientError as e:
        logger.error(f"S3/DynamoDB error for file_id {file_id}, user {user}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Error accessing file data: {str(e)}")
    except pd.errors.EmptyDataError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The file is empty or unparseable.")
    except Exception as e:
        logger.error(f"Error processing file {file_id} for user {user}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Could not process file: {str(e)}")


# --- API Endpoints (les endpoints existants restent) ---
# POST /files/initiate-upload
# POST /files/confirm-upload
# GET /files
# GET /files/{file_id}/download-url (toujours utile si le client veut le fichier brut)
# DELETE /files/{file_id}
# ... (leur code reste le même qu'avant) ...

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
    
    try:
        s3_client.head_object(Bucket=BUCKET_NAME, Key=payload.s3_object_key)
    except ClientError as e:
        if e.response['Error']['Code'] == '404':
            logger.error(f"S3 object not found for confirmation: {payload.s3_object_key}")
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Uploaded file not found on S3.")
        logger.error(f"S3 ClientError checking object {payload.s3_object_key}: {e}", exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Error verifying file on S3.")

    item = {
        'user': user, 
        'file_id': payload.file_id, 
        'original_filename': payload.original_filename,
        's3_object_key': payload.s3_object_key,
        'file_type': payload.file_type,
        'upload_timestamp': timestamp,
        'file_size': payload.file_size,
        'status': 'uploaded',
        'processingStatus': 'pending_lambda' # Statut initial avant que la lambda ne traite
    }

    try:
        files_table.put_item(Item=item)
        logger.info(f"Confirmed upload and stored metadata for user {user}, file_id {payload.file_id}")
        return FileMetadataResponse(**item)
    except ClientError as e:
        logger.error(f"DynamoDB ClientError during put_item for file_id {payload.file_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to record file metadata: {e.response['Error']['Message']}")
    except Exception as e:
        logger.error(f"Unexpected error during file metadata storage for {payload.file_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error during file metadata storage")


@app.get("/files", response_model=List[FileMetadataResponse])
async def get_user_files(authorization: Union[str, None] = Header(default=None)):
    user = authorization
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not authenticated")

    logger.info(f"Fetching files for user: '{user}'")
    try:
        response = files_table.query(KeyConditionExpression=Key('user').eq(user))
        items = response.get('Items', [])
        sorted_items = sorted(items, key=lambda x: x.get('upload_timestamp', ''), reverse=True)
        return [FileMetadataResponse(**item) for item in sorted_items]
    except ClientError as e:
        logger.error(f"DynamoDB ClientError fetching files for user {user}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Database error: {e.response['Error']['Message']}")
    except Exception as e:
        logger.error(f"!!! UNEXPECTED EXCEPTION fetching files for user {user}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error during file retrieval")


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

@app.delete("/files/{file_id}", status_code=status.HTTP_200_OK)
async def delete_file(file_id: str, authorization: Union[str, None] = Header(default=None)):
    user = authorization
    if not user: raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not authenticated")
    # ... (code de suppression existant)
    try:
        get_response = files_table.get_item(Key={'user': user, 'file_id': file_id})
        item_to_delete = get_response.get('Item')
        if not item_to_delete:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
        s3_object_key = item_to_delete.get('s3_object_key')
        if s3_object_key and BUCKET_NAME:
            try:
                s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_object_key)
            except ClientError as e: logger.error(f"S3 Error deleting {s3_object_key}: {e}") # Non bloquant
        delete_response = files_table.delete_item(Key={'user': user, 'file_id': file_id}, ReturnValues='ALL_OLD')
        if not delete_response.get('Attributes'):
             raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File was already deleted or not found during final delete.")
        return {"message": "File deleted successfully", "deleted_file": FileMetadataResponse(**delete_response.get('Attributes'))}
    except ClientError as e: raise HTTPException(status_code=500, detail=f"DB error: {e.response['Error']['Message']}")
    except HTTPException: raise
    except Exception as e: raise HTTPException(status_code=500, detail="Server error during deletion")


# --- NOUVEAUX ENDPOINTS POUR STATISTIQUES ET GRAPHIQUES ---

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
    # Pour le graphique boxplot de Chart.js, on donne souvent min, q1, median, q3, max
    # et la bibliothèque calcule les moustaches (whiskers) jusqu'aux données non-outliers.
    # Ici, on renvoie les valeurs calculées. Le plugin boxplot peut aussi prendre les données brutes.
    # Pour la simplicité, nous renvoyons les statistiques calculées pour que le frontend n'ait qu'à les afficher.

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