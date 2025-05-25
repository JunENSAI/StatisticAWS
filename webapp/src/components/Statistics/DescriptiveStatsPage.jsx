import React, { useState, useEffect } from 'react';
import './DescriptiveStatsPage.css';
// Importez les nouvelles fonctions API
import { getUserFiles, fetchFileStatistics } from '../../services/apiService';

function DescriptiveStatsPage() {
  const [userFiles, setUserFiles] = useState([]);
  const [selectedFileId, setSelectedFileId] = useState('');
  const [fileMetadata, setFileMetadata] = useState(null); // Pour stocker les métadonnées du fichier sélectionné, y compris les en-têtes
  const [headers, setHeaders] = useState([]);
  const [selectedVariableForStats, setSelectedVariableForStats] = useState('');
  const [descriptiveStats, setDescriptiveStats] = useState(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadFiles = async () => {
      setIsLoadingFiles(true);
      setError('');
      try {
        const files = await getUserFiles();
        setUserFiles(files.map(f => ({
          id: f.file_id,
          name: f.original_filename,
          // Stocker les en-têtes si la Lambda les a fournis
          columnHeaders: f.columnHeaders || [], 
        })));
      } catch (err) {
        setError(err.message || 'Erreur lors de la récupération des fichiers.');
        console.error(err);
      } finally {
        setIsLoadingFiles(false);
      }
    };
    loadFiles();
  }, []);

  const handleFileSelection = (event) => {
    const fileId = event.target.value;
    setSelectedFileId(fileId);
    setDescriptiveStats(null);
    setSelectedVariableForStats('');
    setError('');
    if (fileId) {
      const selected = userFiles.find(f => f.id === fileId);
      setFileMetadata(selected);
      setHeaders(selected?.columnHeaders || []);
    } else {
      setFileMetadata(null);
      setHeaders([]);
    }
  };

  const handleVariableSelectionForStats = async (event) => {
    const variableName = event.target.value;
    setSelectedVariableForStats(variableName);
    if (!variableName || !selectedFileId) {
      setDescriptiveStats(null);
      return;
    }
    setIsLoadingStats(true);
    setError('');
    try {
      const statsData = await fetchFileStatistics(selectedFileId, variableName);
      setDescriptiveStats(statsData);
    } catch (err) {
      setError(err.message || `Erreur lors du calcul des statistiques pour ${variableName}.`);
      console.error(err);
      setDescriptiveStats(null);
    } finally {
      setIsLoadingStats(false);
    }
  };

  if (isLoadingFiles) return <p>Chargement des fichiers...</p>;
  // if (error && userFiles.length === 0) return <p style={{color: 'red'}}>{error}</p>; // Erreur initiale
  if (!isLoadingFiles && userFiles.length === 0 && !error) return <p>Aucun fichier déposé.</p>;


  return (
    <div className="stats-page-container">
      <h3>Statistiques Descriptives</h3>
      {error && <p style={{color: 'red'}}>{error}</p>}
      <div className="controls">
        <label htmlFor="file-select-stats">Sélectionner une base de données :</label>
        <select id="file-select-stats" value={selectedFileId} onChange={handleFileSelection} disabled={isLoadingFiles}>
          <option value="">-- Choisir une base --</option>
          {userFiles.map(file => (
            <option key={file.id} value={file.id}>{file.name}</option>
          ))}
        </select>
      </div>

      {selectedFileId && headers.length > 0 && (
        <div className="variables-section">
          <h4>Variables disponibles pour "{fileMetadata?.name}" :</h4>
           <div className="controls">
            <label htmlFor="variable-select-stats">Choisir une variable :</label>
            <select id="variable-select-stats" value={selectedVariableForStats} onChange={handleVariableSelectionForStats} disabled={isLoadingStats}>
                <option value="">-- Sélectionner une variable --</option>
                {headers.map(header => (
                  <option key={header} value={header}>{header}</option>
                ))}
            </select>
           </div>
        </div>
      )}
      {selectedFileId && headers.length === 0 && fileMetadata && <p>Aucun en-tête trouvé pour ce fichier (vérifiez si la Lambda a traité le fichier).</p>}


      {isLoadingStats && <p>Calcul des statistiques...</p>}

      {descriptiveStats && !isLoadingStats && (
        <div className="stats-results">
          <h4>Statistiques pour "{descriptiveStats.variable_name}"</h4>
          <p><strong>Type de données détecté:</strong> {descriptiveStats.data_type_detected}</p>
          <p><strong>Nombre d'observations valides:</strong> {descriptiveStats.count}</p>
          <p><strong>Nombre d'observations manquantes:</strong> {descriptiveStats.missing_values}</p>
          
          {descriptiveStats.data_type_detected === 'numeric' && (
            <>
              <p><strong>Min:</strong> {descriptiveStats.min_val?.toFixed(2)}</p>
              <p><strong>Max:</strong> {descriptiveStats.max_val?.toFixed(2)}</p>
              <p><strong>Moyenne:</strong> {descriptiveStats.mean?.toFixed(2)}</p>
              <p><strong>Médiane:</strong> {descriptiveStats.median?.toFixed(2)}</p>
              <p><strong>Écart-type:</strong> {descriptiveStats.std_dev?.toFixed(2)}</p>
              <p><strong>Q1 (1er Quartile):</strong> {descriptiveStats.q1?.toFixed(2)}</p>
              <p><strong>Q3 (3ème Quartile):</strong> {descriptiveStats.q3?.toFixed(2)}</p>
            </>
          )}
          {descriptiveStats.data_type_detected === 'categorical' && descriptiveStats.top_frequencies && (
            <>
              <p><strong>Nombre de valeurs distinctes:</strong> {descriptiveStats.unique_values_count}</p>
              <h5>Fréquences (Top 10):</h5>
              <ul>
                {descriptiveStats.top_frequencies.map((item, index) => (
                  <li key={index}>{item.value}: {item.count}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default DescriptiveStatsPage;