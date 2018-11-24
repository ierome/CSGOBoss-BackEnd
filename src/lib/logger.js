
import { Logger, transports } from 'winston'

export default new Logger({
  transports: [
    new transports.Console({
      prettyPrint: o => JSON.stringify(o)
    })
  ]
})
