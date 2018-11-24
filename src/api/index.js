
import { Router } from 'express'
import twilio from './twilio'

export default () => {
  const router = Router()
  router.use('/twilio', twilio())
  return router
}
