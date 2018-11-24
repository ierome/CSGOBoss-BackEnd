
import _ from 'underscore'

export function chunk(array,chunkSize) {
	return _.reduce(array, (reducer, item, index) => {
		reducer.current.push(item)

		if(reducer.current.length === chunkSize || index + 1 === array.length) {
			reducer.chunks.push(reducer.current)
			reducer.current = []
		}

		return reducer
	}, {
    current:[],
    chunks: []
  }).chunks
}
