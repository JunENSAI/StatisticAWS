import React, { useState, useCallback } from 'react';
import FileProgressBar from './FileProgressBar';
import FileListTable from './FileListTable';
import { initiateUpload as apiInitiateUpload, confirmUpload as apiConfirmUpload } from '../../services/apiService';
import './FileUploadPage.css';


// La fonction FileUploadPage sert à s'assurer que le fichier est bien televersé vers le S3 crée par le code terraform main_serverless
// elle gère notamment les changements possible de fichier selon la pratique de l'utilisateur.
function FileUploadPage({ onFileUploaded, uploadedFiles }) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState('');

  // ceci est utile lorsque l'on veut changer le fichier 
  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (file && (file.type === "text/csv" || file.name.endsWith('.csv') || file.type === "text/xlsx" || file.name.endsWith('.xlsx'))) {
      setSelectedFile(file);
      setMessage('');
      setUploadProgress(0); // reinitialise à 0 la progression pour un nouveau fichier à importer
    } else {
      setSelectedFile(null);
      setMessage('Veuillez sélectionner un fichier CSV ou Excel (.csv, .xlsx).');
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setMessage('Veuillez d\'abord sélectionner un fichier.');
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    setMessage(`Préparation du téléversement de ${selectedFile.name}...`);

    try {
      const initiateResponse = await apiInitiateUpload(selectedFile.name, selectedFile.type);
      const { upload_url, s3_object_key, file_id } = initiateResponse;

      setMessage(`Téléversement de ${selectedFile.name} vers S3...`);

      const s3UploadResponse = await fetch(upload_url, {
        method: 'PUT',
        body: selectedFile,
        headers: {
          'Content-Type': selectedFile.type,
        },
      });

      if (!s3UploadResponse.ok) {
        throw new Error('Échec du téléversement direct vers S3.');
      }

      let progress = 0;
      const interval = setInterval(() => {
          progress += 20;
          if (progress <= 100) {
              setUploadProgress(progress);
          } else {
              clearInterval(interval);
              apiConfirmUpload(file_id, s3_object_key, selectedFile.name, selectedFile.type, selectedFile.size)
                .then(confirmedFile => {
                  setMessage(`${confirmedFile.original_filename} a été déposé avec succès !`);
                  const fileInfoForTable = {
                      id: confirmedFile.file_id,
                      name: confirmedFile.original_filename,
                      uploadedAt: new Date(confirmedFile.upload_timestamp).toLocaleString(),
                      status: confirmedFile.status,
                  };
                  onFileUploaded(fileInfoForTable);
                })
                .catch(confirmError => {
                  console.error("Erreur de confirmation:", confirmError);
                  setMessage(`Erreur lors de la confirmation du téléversement : ${confirmError.message}`);
                })
                .finally(() => {
                  setIsUploading(false);
                  setSelectedFile(null);
                });
          }
      }, 100);


    } catch (error) {
      console.error("Erreur d'upload:", error);
      setMessage(`Erreur : ${error.message}`);
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  return (
    <div className="file-upload-container">
      <h3>Déposer un nouveau fichier (CSV ou Excel)</h3>
      <div className="upload-form">
        <input type="file" accept=".csv, .xlsx, text/xlsx, text/csv" onChange={handleFileChange} />
        <button onClick={handleUpload} disabled={!selectedFile || isUploading}>
          {isUploading ? 'Téléversement...' : 'Déposer le fichier'}
        </button>
      </div>

      {isUploading && <FileProgressBar progress={uploadProgress} />}
      {message && <p className={`upload-message ${message.includes('succès') ? 'success' : 'error'}`}>{message}</p>}

      <hr className="separator" />

      <FileListTable files={uploadedFiles} />
    </div>
  );
}

export default FileUploadPage;