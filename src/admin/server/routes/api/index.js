
import { Router } from 'express'
import items from './items'

export default () => {
  const router = Router()
  router.use('/items', items())
  return router
}
