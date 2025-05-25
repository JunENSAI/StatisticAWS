import React from 'react';
import './FileListTable.css';


// function qui se charge de montrer la liste des tables pour un utilisateur donné. On y verra les information : ID base, date de dépot, statut
function FileListTable({ files }) {
  if (!files || files.length === 0) {
    return <p>Aucune base de données déposée pour le moment.</p>;
  }

  return (
    <div className="file-list-container">
      <h4>Mes Bases de Données Déposées</h4>
      <div className="bases-grid">
        {files.map((file, index) => (
          <div key={file.id || index} className="base-card">
            <h5>{file.name}</h5>
            <p><strong>ID Base:</strong> {file.id}</p>
            <p><strong>Déposé le:</strong> {file.uploadedAt}</p>
            <p><strong>Statut:</strong> <span className={`status ${file.status?.toLowerCase()}`}>{file.status}</span></p>
          </div>
        ))}
      </div>
    </div>
  );
}

export default FileListTable;