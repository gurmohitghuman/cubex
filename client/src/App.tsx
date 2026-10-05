import { Outlet } from 'react-router-dom'
import { AuthProvider } from './contexts/AuthContext'

function App() {
  return (
    <AuthProvider>
      <div className="h-screen bg-gray-50 overflow-auto">
        <Outlet />
      </div>
    </AuthProvider>
  )
}

export default App
