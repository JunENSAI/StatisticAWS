import React, { useState, useCallback } from 'react';
import FileProgressBar from './FileProgressBar';
import FileListTable from './FileListTable';
import { initiateUpload as apiInitiateUpload, confirmUpload as apiConfirmUpload } from '../../services/apiService'; // Importez
import './FileUploadPage.css';

function FileUploadPage({ onFileUploaded, uploadedFiles }) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [message, setMessage] = useState('');

  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (file && (file.type === "text/csv" || file.name.endsWith('.csv') || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || file.name.endsWith('.xlsx'))) {
      setSelectedFile(file);
      setMessage('');
      setUploadProgress(0); // Réinitialiser la progression si un nouveau fichier est sélectionné
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
      // 1. Initier le téléversement auprès de notre backend
      const initiateResponse = await apiInitiateUpload(selectedFile.name, selectedFile.type);
      const { upload_url, s3_object_key, file_id } = initiateResponse;

      setMessage(`Téléversement de ${selectedFile.name} vers S3...`);

      // 2. Téléverser le fichier directement vers S3 en utilisant l'URL pré-signée
      const s3UploadResponse = await fetch(upload_url, {
        method: 'PUT',
        body: selectedFile,
        headers: {
          'Content-Type': selectedFile.type,
        },
        // Pour suivre la progression, vous pourriez utiliser XMLHttpRequest
        // ou une bibliothèque qui gère les uploads avec progression.
        // fetch ne le supporte pas nativement de manière simple pour les uploads.
        // Pour la démo, on simule la progression après l'appel.
      });

      if (!s3UploadResponse.ok) {
        throw new Error('Échec du téléversement direct vers S3.');
      }

      // Simulation de la barre de progression après l'upload S3 (pour la démo)
      // Dans une vraie app avec suivi de progression, ce serait plus intégré.
      let progress = 0;
      const interval = setInterval(() => {
          progress += 20;
          if (progress <= 100) {
              setUploadProgress(progress);
          } else {
              clearInterval(interval);
              // 3. Confirmer le téléversement auprès de notre backend
              apiConfirmUpload(file_id, s3_object_key, selectedFile.name, selectedFile.type, selectedFile.size)
                .then(confirmedFile => {
                  setMessage(`${confirmedFile.original_filename} a été déposé avec succès !`);
                  const fileInfoForTable = { // Adapter pour correspondre à FileMetadataResponse du backend
                      id: confirmedFile.file_id,
                      name: confirmedFile.original_filename,
                      uploadedAt: new Date(confirmedFile.upload_timestamp).toLocaleString(),
                      status: confirmedFile.status,
                      // ajoutez d'autres champs si nécessaire pour l'affichage
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
        <input type="file" accept=".csv, .xlsx, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, text/csv" onChange={handleFileChange} />
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