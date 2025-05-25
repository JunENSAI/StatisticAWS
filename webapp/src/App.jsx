import React, { useState } from 'react';
import LoginPage from './components/Auth/LoginPage';
import HomePage from './pages/HomePage';
import './App.css';
function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState('');

  const handleLogin = (user) => {
    setUsername(user);
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    localStorage.removeItem('username');
    setIsAuthenticated(false);
    setUsername('');
  };

  if (!isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <HomePage username={username} onLogout={handleLogout} />;
}

export default App;