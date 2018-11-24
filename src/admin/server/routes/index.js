
import { Router } from 'express'

import api from './api'

export default () => {
  const router = Router()
  router.use('/api', api())
  return router
}
