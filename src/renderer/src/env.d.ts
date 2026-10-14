/// <reference types="vite/client" />
import type { IrisApi } from '../../shared/api'

declare global {
  interface Window {
    iris: IrisApi
  }
}
