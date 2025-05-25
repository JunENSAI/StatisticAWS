import React, { useState, useEffect, useRef } from 'react';
import './GraphsPage.css';
import { getUserFiles, fetchBoxplotData } from '../../services/apiService'; // Importez
import { Chart, registerables } from 'chart.js';
import { BoxPlotController, BoxAndWiskers } from '@sgratzl/chartjs-chart-boxplot';

Chart.register(...registerables, BoxPlotController, BoxAndWiskers);

function GraphsPage() {
  const [userFiles, setUserFiles] = useState([]);
  const [selectedFileIdG, setSelectedFileIdG] = useState('');
  const [fileMetadataG, setFileMetadataG] = useState(null);
  const [headersG, setHeadersG] = useState([]);
  const [selectedVariableG, setSelectedVariableG] = useState('');
  
  const chartRef = useRef(null);
  const chartInstanceRef = useRef(null);

  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingGraphData, setIsLoadingGraphData] = useState(false);
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
          columnHeaders: f.columnHeaders || [],
        })));
      } catch (err) {
        setError(err.message || 'Erreur lors de la récupération des fichiers.');
      } finally {
        setIsLoadingFiles(false);
      }
    };
    loadFiles();
  }, []);

  const handleFileSelectionG = (event) => {
    const fileId = event.target.value;
    setSelectedFileIdG(fileId);
    setSelectedVariableG('');
    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
      chartInstanceRef.current = null;
    }
    setError('');
    if (fileId) {
      const selected = userFiles.find(f => f.id === fileId);
      setFileMetadataG(selected);
      setHeadersG(selected?.columnHeaders || []);
    } else {
      setFileMetadataG(null);
      setHeadersG([]);
    }
  };

  const handleVariableSelectionG = async (event) => {
    const varName = event.target.value;
    setSelectedVariableG(varName);

    if (chartInstanceRef.current) {
      chartInstanceRef.current.destroy();
      chartInstanceRef.current = null;
    }
    if (!varName || !selectedFileIdG || !chartRef.current) {
      return;
    }

    setIsLoadingGraphData(true);
    setError('');
    try {
      const boxplotStats = await fetchBoxplotData(selectedFileIdG, varName);
      
      // Les données pour le plugin boxplot avec statistiques pré-calculées
      // Le plugin s'attend à un tableau de valeurs [min, q1, median, q3, max] pour chaque boxplot.
      // Il peut aussi gérer les outliers séparément.
      const dataForChart = [
          boxplotStats.min_val,
          boxplotStats.q1,
          boxplotStats.median,
          boxplotStats.q3,
          boxplotStats.max_val
      ];

      const chartConfig = {
        type: 'boxplot',
        data: {
          labels: [boxplotStats.variable_name],
          datasets: [{
            label: `Boxplot de ${boxplotStats.variable_name}`,
            data: [dataForChart], // Un tableau contenant notre tableau de stats
            backgroundColor: 'rgba(0, 123, 255, 0.5)',
            borderColor: 'rgb(0, 123, 255)',
            borderWidth: 1,
            // outliers: [boxplotStats.outliers] // Si le plugin gère les outliers de cette manière
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { y: { beginAtZero: false } }, // Ajuster beginAtZero selon les données
          plugins: { legend: { display: true }, title: { display: true, text: `Boxplot pour ${boxplotStats.variable_name}` } }
        }
      };
      chartInstanceRef.current = new Chart(chartRef.current, chartConfig);

    } catch (err) {
      setError(err.message || `Erreur lors de la récupération des données pour le graphique de ${varName}.`);
      console.error(err);
    } finally {
      setIsLoadingGraphData(false);
    }
  };

  if (isLoadingFiles) return <p>Chargement des fichiers...</p>;
  // if (error && userFiles.length === 0) return <p style={{color: 'red'}}>{error}</p>;
  if (!isLoadingFiles && userFiles.length === 0 && !error) return <p>Aucun fichier déposé.</p>;

  return (
    <div className="graphs-page-container">
      <h3>Graphiques (Boxplot)</h3>
      {error && <p style={{color: 'red'}}>{error}</p>}
      <div className="controls-graph">
        <label htmlFor="base-select-graph">Sélectionner une base :</label>
        <select id="base-select-graph" value={selectedFileIdG} onChange={handleFileSelectionG} disabled={isLoadingFiles}>
          <option value="">-- Choisir une base --</option>
          {userFiles.map(file => (
            <option key={file.id} value={file.id}>{file.name}</option>
          ))}
        </select>
      </div>

      {selectedFileIdG && headersG.length > 0 && (
        <div className="controls-graph">
          <label htmlFor="variable-select-graph">Sélectionner une variable (numérique) :</label>
          <select id="variable-select-graph" value={selectedVariableG} onChange={handleVariableSelectionG} disabled={isLoadingGraphData}>
            <option value="">-- Choisir une variable --</option>
            {headersG.map(variable => (
              <option key={variable} value={variable}>{variable}</option>
            ))}
          </select>
        </div>
      )}
       {selectedFileIdG && headersG.length === 0 && fileMetadataG && <p>Aucun en-tête trouvé pour ce fichier.</p>}


      <div className="chart-display-area">
        {isLoadingGraphData && <p>Chargement des données du graphique...</p>}
        {!isLoadingGraphData && selectedVariableG && (
          <div className="chart-container">
             <canvas ref={chartRef}></canvas>
          </div>
        )}
        {!selectedVariableG && !isLoadingGraphData && (
          <div className="boxplot-placeholder">
            <p>Sélectionnez une base et une variable pour afficher le graphique Boxplot.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default GraphsPage;