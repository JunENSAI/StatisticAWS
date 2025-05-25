const API_BASE_URL = 'http://localhost:8080'; //pourrait être aussi le dns du load balancer (portail vers l'api).

const getAuthHeader = () => {
  const username = localStorage.getItem('username');
  if (username) {
    return { 'Authorization': username };
  }
  return {};
};

// --- Fonctions d'upload ---
export const initiateUpload = async (filename, filetype) => {
  const response = await fetch(`${API_BASE_URL}/files/initiate-upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
    },
    body: JSON.stringify({ filename, filetype }),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.detail || errorData.message || 'Failed to initiate upload');
  }
  return response.json();
};

export const confirmUpload = async (fileId, s3ObjectKey, originalFilename, fileType, fileSize) => {
  const response = await fetch(`${API_BASE_URL}/files/confirm-upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
    },
    body: JSON.stringify({
      file_id: fileId,
      s3_object_key: s3ObjectKey,
      original_filename: originalFilename,
      file_type: fileType,
      file_size: fileSize,
    }),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.detail || errorData.message || 'Failed to confirm upload');
  }
  return response.json();
};

// --- Fonctions de gestion de fichiers ---
export const getUserFiles = async () => {
  const response = await fetch(`${API_BASE_URL}/files`, {
    headers: {
      ...getAuthHeader(),
    }
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.detail || errorData.message || 'Failed to fetch user files');
  }
  return response.json();
};

export const deleteFileApi = async (fileId) => {
  const response = await fetch(`${API_BASE_URL}/files/${fileId}`, {
    method: 'DELETE',
    headers: {
      ...getAuthHeader(),
    },
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.detail || errorData.message || 'Failed to delete file');
  }
  return response.json();
};


/**
 * Récupère l'URL de téléchargement pré-signée pour un fichier.
 * Utile si l'utilisateur veut télécharger le fichier original.
 * @param {string} fileId - L'ID du fichier.
 * @returns {Promise<object>} - Un objet contenant download_url et s3_object_key.
 */
export const getFileDownloadUrl = async (fileId) => {
  const response = await fetch(`${API_BASE_URL}/files/${fileId}/download-url`, {
    headers: {
      ...getAuthHeader(),
    }
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.detail || errorData.message || 'Failed to get file download URL');
  }
  return response.json();
};

/**
 * Télécharge le contenu d'un fichier en utilisant une URL pré-signée.
 * @param {string} downloadUrl - L'URL de téléchargement pré-signée.
 * @returns {Promise<Blob>} - Le contenu du fichier sous forme de Blob.
 */
export const downloadFileContent = async (downloadUrl) => {
  const response = await fetch(downloadUrl); // Pas besoin de headers d'auth ici, l'URL est pré-signée
  if (!response.ok) {
    const errorText = await response.text();
    console.error("S3 Download Error Text:", errorText);
    throw new Error(`Failed to download file content from S3. Status: ${response.status}`);
  }
  return response.blob();
};


// --- FONCTIONS POUR LES DONNÉES TRAITÉES PAR LE BACKEND (STATS ET GRAPHIQUES) ---

/**
 * Récupère les statistiques descriptives pour une variable d'un fichier, calculées par le backend.
 * @param {string} fileId - L'ID du fichier.
 * @param {string} variableName - Le nom de la variable (colonne).
 * @returns {Promise<object>} - Les données statistiques.
 */
export const fetchFileStatistics = async (fileId, variableName) => {
  const encodedVariableName = encodeURIComponent(variableName); // Au cas où la variable aurait des caractères spéciaux
  const response = await fetch(`${API_BASE_URL}/files/${fileId}/statistics/${encodedVariableName}`, {
    headers: { ...getAuthHeader() }
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.detail || errorData.message || 'Failed to fetch statistics');
  }
  return response.json();
};

/**
 * Récupère les données nécessaires pour un boxplot d'une variable, calculées par le backend.
 * @param {string} fileId - L'ID du fichier.
 * @param {string} variableName - Le nom de la variable (colonne).
 * @returns {Promise<object>} - Les données pour le boxplot.
 */
export const fetchBoxplotData = async (fileId, variableName) => {
  const encodedVariableName = encodeURIComponent(variableName);
  const response = await fetch(`${API_BASE_URL}/files/${fileId}/graph-data/boxplot/${encodedVariableName}`, {
    headers: { ...getAuthHeader() }
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.detail || errorData.message || 'Failed to fetch boxplot data');
  }
  return response.json();
};