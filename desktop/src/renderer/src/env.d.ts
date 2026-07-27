/// <reference types="vite/client" />

import type { FafoApi } from '../../shared/types'

declare global {
  interface Window {
    fafo: FafoApi
  }
}

export {}
