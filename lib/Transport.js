'use strict'

const debug = require('debug')('elasticsearch')
const once = require('once')
const {
  ConnectionError,
  TimeoutError,
  NoLivingConnectionsError,
  ResponseError
} = require('./errors')

const noop = () => {}
const kRemainingAttempts = Symbol('elasticsearch-remaining-attempts')

class Transport {
  constructor (opts = {}) {
    this.emit = opts.emit
    this.connectionPool = opts.connectionPool
    this.serializer = opts.serializer
    this.maxRetries = opts.maxRetries
    this.requestTimeout = opts.requestTimeout
    this.sniffInterval = opts.sniffInterval
    this.sniffOnConnectionFault = opts.sniffOnConnectionFault
    this.sniffEndpoint = opts.sniffEndpoint

    this._sniffEnabled = typeof this.sniffInterval === 'number'
    this._nextSniff = this._sniffEnabled ? (Date.now() + this.sniffInterval) : 0
    this._isSniffing = false

    if (opts.sniffOnStart === true) {
      this.sniff()
    }
  }

  request (params, callback) {
    callback = once(callback)
    const attempts = params[kRemainingAttempts] || params.maxRetries || this.maxRetries
    const connection = this.getConnection()
    if (connection === null) {
      return callback(new NoLivingConnectionsError('There are not living connections'))
    }

    if (params.body != null) {
      try {
        params.body = this.serializer.serialize(params.body)
      } catch (err) {
        return callback(err)
      }
      params.headers = params.headers || {}
      params.headers['Content-Type'] = 'application/json'
      params.headers['Content-Length'] = '' + Buffer.byteLength(params.body)
    }

    params.timeout = params.timeout || this.requestTimeout
    this.emit('request', params)
    const request = connection.request(params, (err, response) => {
      if (err != null) {
        this.connectionPool.markDead(connection)
        if (this.sniffOnConnectionFault === true) {
          this.sniff()
        }

        if (attempts > 0) {
          debug(`Retrying request, there are still ${attempts} attempts`, params)
          params[kRemainingAttempts] = attempts - 1
          return this.request(params, callback)
        }

        const error = err.message === 'Request timed out'
          ? new TimeoutError(err.message)
          : new ConnectionError(err.message)

        this.emit('error', error, params)
        return callback(error)
      }

      var json = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { json += chunk })
      response.on('error', err => callback(new ConnectionError(err.message)))
      response.on('end', () => {
        debug('JSON response', params, json)
        this.connectionPool.markAlive(connection)
        const contentType = response.headers['content-type']
        if (contentType != null && contentType.indexOf('application/json') > -1) {
          try {
            var payload = this.serializer.deserialize(json)
          } catch (err) {
            this.emit('error', err)
            return callback(err)
          }
        } else {
          payload = json
        }
        const { statusCode } = response
        this.emit('response', params, { statusCode, payload })
        if (statusCode >= 400) {
          callback(new ResponseError(payload))
        } else {
          callback(null, payload)
        }
      })
    })

    return {
      abort: () => {
        request.abort()
        debug('Request aborted', params)
      }
    }
  }

  getConnection () {
    const now = Date.now()
    if (this._sniffEnabled === true && now > this._nextSniff) {
      this.sniff()
    }
    this.connectionPool.resurrect(now)
    return this.connectionPool.getConnection()
  }

  sniff (callback = noop) {
    if (this._isSniffing === true) return
    this._isSniffing = true
    debug('Started sniffing request')

    this.request({
      method: 'GET',
      path: this.sniffEndpoint
    }, (err, body) => {
      this._isSniffing = false
      if (this._sniffEnabled === true) {
        this._nextSniff = Date.now() + this.sniffInterval
      }

      if (err != null) {
        debug('Sniffing errored', err)
        return callback(err)
      }

      debug('Sniffing ended successfully', body)
      const hosts = this.connectionPool.nodesToHost(body.nodes)
      this.connectionPool
        .empty()
        .addConnection(hosts)

      callback(null, hosts)
    })
  }
}

module.exports = Transport