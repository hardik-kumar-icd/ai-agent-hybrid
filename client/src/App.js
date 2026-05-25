import React from 'react';
import ChatWidget from './components/ChatWidget';
import './App.css';

function App() {
  // For standalone app testing, use environment variable or default to the production agent.
  // (Previously defaulted to a Render deployment; switched to agent.visor.no when we moved to Lightsail.)
  const baseUrl = process.env.REACT_APP_API_BASE_URL || 'https://agent.visor.no';
  
  return (
    <div className="App">
      <ChatWidget 
        baseUrl={baseUrl}
        themeColor="#667eea"
        accentColor="#764ba2"
        mode="user"
        adminToken={process.env.REACT_APP_ADMIN_TOKEN}
      />
    </div>
  );
}

export default App;
