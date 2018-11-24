
import config from 'config'

// tokenAmount
export function tokenAmount(price) {
  return parseInt(price * config.tokenMultiplier)
}
