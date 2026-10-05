import axios from 'axios'
import toast from 'react-hot-toast'

const API_BASE_URL = '/api'

// Per-request opt-out for the generic 5xx toast below. Callers that surface their
// own error UI (their catch block shows `response.data.error`) pass this so the
// user doesn't see a redundant second "Server error occurred" toast on top of the
// specific message. Set it on the request config: `api.post(url, body, { skipServerErrorToast: true })`.
declare module 'axios' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export interface AxiosRequestConfig {
    skipServerErrorToast?: boolean
  }
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000, // 30 second timeout for AI requests
  // Auth is an HttpOnly Secure SameSite=Strict cookie set by the server.
  // withCredentials makes the browser attach it to same-origin requests AND include
  // it on cross-origin requests when the server's CORS reply has
  // Access-Control-Allow-Credentials: true (which our Express setup does).
  withCredentials: true,
})

// Send the user back to login on a 401, unless they're already there (a wrong
// password on the login form is a 401 too). Shared so non-axios callers (the
// streaming preview fetch, which bypasses the interceptor) get the SAME
// redirect behavior.
export function redirectToLoginOn401(): void {
  if (window.location.pathname !== '/login') {
    window.location.href = '/login'
  }
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      redirectToLoginOn401()
    } else if (error.response?.status >= 500) {
      // Skip the generic toast when the caller surfaces its own error UI, so the
      // user doesn't get a redundant second toast on top of the specific message.
      if (!error.config?.skipServerErrorToast) {
        toast.error('Server error occurred')
      }
    } else if (error.response?.data?.error) {
      console.error('API Error:', error.response.data.error)
    }
    return Promise.reject(error)
  },
)
