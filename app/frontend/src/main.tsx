import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import App from './App'
import { installGlobalHandlers } from './lib/log'
import { ErrorBoundary } from './components/ErrorBoundary'

// Forward uncaught errors + unhandled promise rejections to the log file.
installGlobalHandlers()

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <ErrorBoundary>
            <App/>
        </ErrorBoundary>
    </React.StrictMode>
)
