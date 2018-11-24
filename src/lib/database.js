
import config from 'config'
import r from 'rethinkdbdash'

export default r(config.database)

export function connection() {
  // TODO: Move database connection to this module, this is temp.
  return tmp_connection()
}
