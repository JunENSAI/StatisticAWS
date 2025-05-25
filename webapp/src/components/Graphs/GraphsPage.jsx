import React, { useState, useEffect, useRef } from 'react';
import './GraphsPage.css';
import { getUserFiles, fetchBoxplotData } from '../../services/apiService';
import { Chart, registerables } from 'chart.js';
import { BoxPlotController, BoxAndWiskers } from '@sgratzl/chartjs-chart-boxplot';

Chart.register(...registerables, BoxPlotController, BoxAndWiskers);

function GraphsPage() {
  const [userFiles, setUserFiles] = useState([]);
  const [selectedFileIdG, setSelectedFileIdG] = useState('');
  const [fileMetadataG, setFileMetadataG] = useState(null); // Stocke les métadonnées du fichier sélectionné
  const [headersG, setHeadersG] = useState([]);
  const [selectedVariableG, setSelectedVariableG] = useState('');
  
  const chartRef = useRef(null); // Référence pour l'élément <canvas>
  const chartInstanceRef = useRef(null); // Référence pour l'instance Chart.js

  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingGraphData, setIsLoadingGraphData] = useState(false);
  const [error, setError] = useState('');
  const [chartDataForEffect, setChartDataForEffect] = useState(null); // Nouvel état pour déclencher useEffect

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
          columnHeaders: f.columnHeaders || [], // S'assurer que columnHeaders est toujours un tableau
        })));
      } catch (err) {
        setError(err.message || 'Erreur lors de la récupération des fichiers.');
        console.error("Erreur chargement fichiers:", err);
      } finally {
        setIsLoadingFiles(false);
      }
    };
    loadFiles();
  }, []); // Tableau de dépendances vide pour exécuter une seule fois au montage

  // Gérer la sélection d'un fichier
  const handleFileSelectionG = (event) => {
    const fileId = event.target.value;
    setSelectedFileIdG(fileId);
    setSelectedVariableG(''); // Réinitialiser la variable sélectionnée
    setChartDataForEffect(null); // Réinitialiser les données du graphique
    setError(''); // Réinitialiser les erreurs

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
    setChartDataForEffect(null); // Réinitialiser pour forcer la mise à jour si l'utilisateur re-sélectionne
    setError('');

    if (!varName || !selectedFileIdG) {
      return;
    }

    setIsLoadingGraphData(true);
    try {
      const boxplotStats = await fetchBoxplotData(selectedFileIdG, varName);
      console.log("Données du boxplot reçues du backend:", boxplotStats);

      // Préparer les données pour le graphique
      const dataForChart = [ // Format [min, q1, median, q3, max]
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
        // outliers: boxplotStats.outliers || [] // Si vous gérez les outliers
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
    // S'assurer que nous avons des données, que la référence au canvas existe,
    // et qu'une variable est bien sélectionnée (pour éviter de dessiner un graphique vide au début)
    if (chartDataForEffect && chartRef.current && selectedVariableG) {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy(); // Détruire l'instance précédente
      }

      console.log("Tentative de création du graphique. chartRef.current:", chartRef.current);
      console.log("Données pour la configuration du graphique:", chartDataForEffect);

      const chartConfig = {
        type: 'boxplot', // Type de graphique
        data: {
          labels: [chartDataForEffect.variableName],
          datasets: [{
            label: `Boxplot de ${chartDataForEffect.variableName}`,
            data: [chartDataForEffect.dataPoints], // Doit être un tableau de tableaux de données/statistiques
            backgroundColor: 'rgba(0, 123, 255, 0.5)',
            borderColor: 'rgb(0, 123, 255)',
            borderWidth: 1,
            // outliers: chartDataForEffect.outliers ? [chartDataForEffect.outliers] : undefined,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false, // Important pour contrôler la taille via CSS
          scales: { 
            y: { 
              beginAtZero: false, // Généralement false pour les boxplots pour mieux voir la distribution
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
      {/* Afficher l'erreur non critique ici aussi */}
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
      {/* Message si un fichier est sélectionné mais n'a pas d'en-têtes (ou si la Lambda n'a pas encore traité) */}
      {selectedFileIdG && headersG.length === 0 && fileMetadataG && !isLoadingFiles && 
        <p>Les en-têtes pour ce fichier ne sont pas encore disponibles. Veuillez vérifier si le traitement du fichier est terminé.</p>
      }

      <div className="chart-display-area">
        {isLoadingGraphData && <p>Chargement des données du graphique...</p>}
        {/* Le canvas doit être présent dans le DOM pour que chartRef.current soit initialisé */}
        {/* On conditionne son conteneur plutôt que le canvas lui-même si possible, ou on s'assure qu'il est là avant l'appel à useEffect */}
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