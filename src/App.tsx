import React from 'react';
import SheetMetaGenerator from './components/SheetMetaGenerator';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <h1>AI Meta Tag Generator from Google Sheet</h1>
      </header>
      <main>
        <SheetMetaGenerator />
      </main>
      <footer>
        <p>Ensure your Google Sheet is public (viewable by anyone with the link) and URLs are in Column A.</p>
        <p>For CSV export, your link might look like: <code>https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv&gid=GID</code> (or without GID for the first sheet).</p>
      </footer>
    </div>
  );
}

export default App;
