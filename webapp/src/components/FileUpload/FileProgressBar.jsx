import React from 'react';
import './FileProgressBar.css';

// lors du televersement vers le s3 une barre de progression sera visible pour montrer l'état d'avancement du televersement du fichier en question.

function FileProgressBar({ progress }) {
  return (
    <div className="progress-bar-container">
      <div
        className="progress-bar"
        style={{ width: `${progress}%` }}
      >
        {progress > 0 && `${progress}%`}
      </div>
    </div>
  );
}

export default FileProgressBar;