import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installRendererLogging } from './lib/logging'
import 'virtual:uno.css'
import './styles.css'

installRendererLogging()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
