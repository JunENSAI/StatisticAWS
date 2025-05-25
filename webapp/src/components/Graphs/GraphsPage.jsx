import React, { useState, useEffect, useRef } from 'react';
import './GraphsPage.css';
import { getUserFiles, fetchBoxplotData } from '../../services/apiService';
import { Chart, registerables } from 'chart.js';
import { BoxPlotController, BoxAndWiskers } from '@sgratzl/chartjs-chart-boxplot';

Chart.register(...registerables, BoxPlotController, BoxAndWiskers);

// Le principe est que pour une variables selectionnée (colonnes du tableau deposé par l'utilisateur) on affiche le graphe de boxplot pour cette variable.

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
  const [chartDataForEffect, setChartDataForEffect] = useState(null);

  // Charger la liste des fichiers au montage du composant
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
        console.error("Erreur chargement fichiers:", err);
      } finally {
        setIsLoadingFiles(false);
      }
    };
    loadFiles();
  }, []); 

  // Gérer la sélection d'un fichier
  const handleFileSelectionG = (event) => {
    const fileId = event.target.value;
    setSelectedFileIdG(fileId);
    setSelectedVariableG('');
    setChartDataForEffect(null);
    setError(''); 

    if (chartInstanceRef.current) { // Détruire l'ancien graphique si existant
      chartInstanceRef.current.destroy();
      chartInstanceRef.current = null;
    }

    if (fileId) {
      const selected = userFiles.find(f => f.id === fileId);
      setFileMetadataG(selected);
      setHeadersG(selected?.columnHeaders || []);
    } else {
      setFileMetadataG(null);
      setHeadersG([]);
    }
  };

  // Gérer la sélection d'une variable et charger les données du graphique
  const handleVariableSelectionG = async (event) => {
    const varName = event.target.value;
    setSelectedVariableG(varName);
    setChartDataForEffect(null);
    setError('');

    if (!varName || !selectedFileIdG) {
      return;
    }

    setIsLoadingGraphData(true);
    try {
      const boxplotStats = await fetchBoxplotData(selectedFileIdG, varName);
      console.log("Données du boxplot reçues du backend:", boxplotStats);

      // Préparer les données pour le graphique
      const dataForChart = [ 
          boxplotStats.min_val,
          boxplotStats.q1,
          boxplotStats.median,
          boxplotStats.q3,
          boxplotStats.max_val
      ];

      // Mettre à jour l'état qui déclenchera useEffect pour créer le graphique
      setChartDataForEffect({
        variableName: boxplotStats.variable_name,
        dataPoints: dataForChart,
      });

    } catch (err) {
      const errorMessage = err.message || `Erreur lors de la récupération des données pour ${varName}.`;
      setError(errorMessage);
      console.error("Erreur fetchBoxplotData:", err);
      setChartDataForEffect(null);
    } finally {
      setIsLoadingGraphData(false);
    }
  };

  // useEffect pour créer/mettre à jour le graphique lorsque chartDataForEffect change
  useEffect(() => {
    if (chartDataForEffect && chartRef.current && selectedVariableG) {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy(); // Détruire l'instance précédente
      }

      console.log("Tentative de création du graphique. chartRef.current:", chartRef.current);
      console.log("Données pour la configuration du graphique:", chartDataForEffect);

      const chartConfig = {
        type: 'boxplot',
        data: {
          labels: [chartDataForEffect.variableName],
          datasets: [{
            label: `Boxplot de ${chartDataForEffect.variableName}`,
            data: [chartDataForEffect.dataPoints],
            backgroundColor: 'rgba(0, 123, 255, 0.5)',
            borderColor: 'rgb(0, 123, 255)',
            borderWidth: 1,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: { 
            y: { 
              beginAtZero: false,
              title: {
                display: true,
                text: chartDataForEffect.variableName
              }
            } 
          },
          plugins: { 
            legend: { 
              display: true,
              position: 'top',
            }, 
            title: { 
              display: true, 
              text: `Distribution de ${chartDataForEffect.variableName}` 
            } 
          }
        }
      };
      
      try {
        chartInstanceRef.current = new Chart(chartRef.current, chartConfig);
      } catch (e) {
        console.error("Erreur lors de l'instanciation de Chart.js:", e);
        setError("Erreur lors de la création du graphique: " + e.message);
      }
    }

    // Fonction de nettoyage : détruire le graphique si les dépendances changent ou si le composant est démonté
    return () => {
      if (chartInstanceRef.current) {
        console.log("Destruction de l'instance du graphique via cleanup useEffect.");
        chartInstanceRef.current.destroy();
        chartInstanceRef.current = null;
      }
    };
  }, [chartDataForEffect, selectedVariableG]); // Dépendances : recréer si les données ou la variable changent


  // Affichage conditionnel pour le chargement et les erreurs initiales
  if (isLoadingFiles) return <p>Chargement des fichiers disponibles...</p>;
  if (error && userFiles.length === 0) return <p style={{ color: 'red' }}>{error}</p>; // Erreur critique au chargement des fichiers
  if (!isLoadingFiles && userFiles.length === 0 && !error) return <p>Aucun fichier déposé. Veuillez d'abord déposer un fichier.</p>;

  return (
    <div className="graphs-page-container">
      <h3>Graphiques (Boxplot)</h3>
      {error && <p style={{ color: 'red' }}>{error}</p>} 
      
      <div className="controls-graph">
        <label htmlFor="base-select-graph">Sélectionner une base :</label>
        <select id="base-select-graph" value={selectedFileIdG} onChange={handleFileSelectionG} disabled={isLoadingFiles || isLoadingGraphData}>
          <option value="">-- Choisir une base --</option>
          {userFiles.map(file => (
            <option key={file.id} value={file.id}>{file.name}</option>
          ))}
        </select>
      </div>

      {selectedFileIdG && headersG.length > 0 && (
        <div className="controls-graph">
          <label htmlFor="variable-select-graph">Sélectionner une variable (numérique) :</label>
          <select id="variable-select-graph" value={selectedVariableG} onChange={handleVariableSelectionG} disabled={isLoadingGraphData || !selectedFileIdG}>
            <option value="">-- Choisir une variable --</option>
            {headersG.map(variable => (
              <option key={variable} value={variable}>{variable}</option>
            ))}
          </select>
        </div>
      )}
      {selectedFileIdG && headersG.length === 0 && fileMetadataG && !isLoadingFiles && 
        <p>Les en-têtes pour ce fichier ne sont pas encore disponibles. Veuillez vérifier si le traitement du fichier est terminé.</p>
      }

      <div className="chart-display-area">
        {isLoadingGraphData && <p>Chargement des données du graphique...</p>}
        <div className="chart-container" style={{ display: selectedVariableG && !isLoadingGraphData && chartDataForEffect ? 'block' : 'none' }}>
           <canvas ref={chartRef}></canvas>
        </div>
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