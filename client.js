const maybe = require('call-me-maybe')
const codecs = require('codecs')
const hypercoreCrypto = require('hypercore-crypto')
const { WriteStream, ReadStream } = require('hypercore-streams')

const { NanoresourcePromise: Nanoresource } = require('nanoresource-promise/emitter')
const HRPC = require('./lib/rpc')

const os = require('os')
const SOCK = os.platform() !== 'win32' ? '/tmp/hyperspace.sock' : '\\\\.\\pipe\\hyperspace'

class Sessions {
  constructor () {
    this._counter = 0
    this._resourceCounter = 0
    this._freeList = []
    this._remoteCores = new Map()
  }
  create (remoteCore) {
    const id = this._freeList.length ? this._freeList.pop() : this._counter++
    this._remoteCores.set(id, remoteCore)
    return id
  }
  createResourceId () {
    return this._resourceCounter++
  }
  delete (id) {
    this._remoteCores.delete(id)
    this._freeList.push(id)
  }
  get (id) {
    return this._remoteCores.get(id)
  }
}

module.exports = class RemoteCorestore extends Nanoresource {
  constructor (opts = {}) {
    super()
    this._client = opts.client
    this._name = opts.name
    this._sock = opts.host || SOCK
    this._sessions = opts.sessions || new Sessions()
  }

  // Nanoresource Methods

  _open () {
    if (this._client) return
    this._client = HRPC.connect(this._sock)
    this._client.hypercore.onRequest(this, {
      onAppend ({ id, length, byteLength}) {
        const remoteCore = this._sessions.get(id)
        if (!remoteCore) throw new Error('Invalid RemoteHypercore ID.')
        remoteCore._onappend({ length, byteLength })
      },
      onClose ({ id }) {
        const remoteCore = this._sessions.get(id)
        if (!remoteCore) throw new Error('Invalid RemoteHypercore ID.')
        remoteCore._onclose()
      },
      onPeerOpen ({ id, peer }) {
        const remoteCore = this._sessions.get(id)
        if (!remoteCore) throw new Error('Invalid RemoteHypercore ID.')
        remoteCore._onpeeropen(peer)
      },
      onPeerRemove ({ id, peer }) {
        const remoteCore = this._sessions.get(id)
        if (!remoteCore) throw new Error('Invalid RemoteHypercore ID.')
        remoteCore._onpeerremove(peer)
      }
    })
    this._client.corestore.onRequest(this, {
      onFeed ({ key }) {
        return this._onfeed(key)
      }
    })
  }

  _close () {
    if (this._name) return
    return this._client.destroy()
  }

  // Events

  _onfeed (key) {
    if (!this.listenerCount('feed')) return
    this.emit('feed', this.get(key, { weak: true, lazy: true }))
  }

  // Public Methods

  ready (cb) {
    return maybe(cb, this.open())
  }

  replicate () {
    throw new Error('Cannot call replicate on a RemoteCorestore')
  }

  default (opts = {}) {
    return this.get(null, { name: this._name })
  }

  get (key, opts = {}) {
    if (key && typeof key !== 'string' && !Buffer.isBuffer(key)) {
      opts = key
      key = opts.key
    }
    if (typeof key === 'string') key = Buffer.from(key, 'hex')
    return new RemoteHypercore(this._client, this._sessions, key, opts)
  }

  namespace (name) {
    return new this.constructor({
      client: this._client,
      sessions: this._sessions,
      name,
    })
  }

  // Networking Methods

  configureNetwork (discoveryKey, opts = {}) {
    return this._client.network.configureNetwork({
      configuration: {
        discoveryKey,
        announce: opts.announce !== false,
        lookup: opts.lookup !== false,
        remember: opts.remember,
      },
      flush: opts.flush
    })
  }

  async getNetworkConfiguration (discoveryKey) {
    const rsp = await this._client.network.getNetworkConfiguration({
      discoveryKey
    })
    return rsp.configuration
  }

  async getAllNetworkConfigurations () {
    const rsp = await this._client.network.getAllNetworkConfigurations()
    return rsp.configurations
  }
}

class RemoteHypercore extends Nanoresource {
  constructor (client, sessions, key, opts) {
    super()
    this.key = key
    this.discoveryKey = null
    this.length = 0
    this.byteLength = 0
    this.writable = false
    this.peers = []
    this.valueEncoding = null
    if (opts.valueEncoding) {
      if (typeof opts.valueEncoding === 'string') this.valueEncoding = codecs(opts.valueEncoding)
      else this.valueEncoding = opts.valueEncoding
    }

    this.weak = !!opts.weak
    this.lazy = !!opts.lazy

    this._client = client
    this._sessions = sessions
    this._name = opts.name

    if (!this.lazy) {
      this._id = this._sessions.create(this)
      this.ready(() => {})
    }
  }

  ready (cb) {
    return maybe(cb, this.open())
  }

  // Nanoresource Methods

  async _open () {
    if (this.lazy) this._id = this._sessions.create(this)
    const rsp = await this._client.corestore.open({
      id: this._id,
      name: this._name,
      key: this.key,
      weak: this.weak
    })
    this.key = rsp.key
    this.discoveryKey = hypercoreCrypto.discoveryKey(this.key)
    this.writable = rsp.writable
    this.length = rsp.length
    this.byteLength = rsp.byteLength
    this.emit('ready')
  }

  async _close () {
    await this._client.hypercore.close({ id: this._id })
    this._sessions.delete(this._id)
    this.emit('close')
  }

  // Events

  _onappend (rsp) {
    this.length = rsp.length
    this.byteLength = rsp.byteLength
    this.emit('append')
  }

  _onclose (rsp) {
    this.emit('close')
  }

  _onpeeropen (peer) {
    const remotePeer = new RemoteHypercorePeer(peer.type, peer.remoteAddress, peer.remotePublicKey)
    this.peers.push(remotePeer)
    this.emit('peer-open', remotePeer)
  }

  _onpeerremove (peer) {
    let remotePeer = null
    let idx = -1
    for (let i = 0; i < this.peers.length; i++) {
      let p = this.peers[i]
      if (p.id === peer.id) {
        remotePeer = p
        idx = i
      }
    }
    if (idx === -1) throw new Error('A peer was removed that was not previously added.')
    this.peers.splice(idx, 1)
    this.emit('peer-remove', remotePeer)
  }

  // Private Methods

  async _append (blocks) {
    if (!Array.isArray(blocks)) blocks = [blocks]
    if (this.valueEncoding) blocks = blocks.map(b => this.valueEncoding.encode(b))
    const rsp = await this._client.hypercore.append({
      id: this._id,
      blocks
    })
    return rsp.seq
  }

  async _get (seq, opts) {
    const rsp = await this._client.hypercore.get({
      ...opts,
      seq,
      id: this._id
    })
    if (opts && opts.valueEncoding) return codecs(opts.valueEncoding).decode(rsp.block)
    if (this.valueEncoding) return this.valueEncoding.decode(rsp.block)
    return rsp.block
  }

  async _update (opts) {
    await this.ready()
    if (typeof opts === 'number') opts = { minLength: opts }
    if (typeof opts.minLength !== 'number') opts.minLength = this.length + 1
    return this._client.hypercore.update({
      ...opts,
      id: this._id
    })
  }

  async _seek (byteOffset, opts) {
    const rsp = await this._client.hypercore.seek({
      byteOffset,
      ...opts,
      id: this._id
    })
    return {
      seq: rsp.seq,
      blockOffset: rsp.blockOffset
    }
  }

  async _has (seq) {
    const rsp = await this._client.hypercore.has({
      seq,
      id: this._id
    })
    return rsp.has
  }

  // Public Methods

  append (blocks, cb) {
    return maybe(cb, this._append(blocks))
  }

  get (seq, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = null
    }
    return maybe(cb, this._get(seq, opts))
  }

  update (opts, cb) {
    return maybe(cb, this._update(opts))
  }

  seek (byteOffset, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts
      opts = null
    }
    const seekProm = this._seek(byteOffset, opts)
    if (!cb) return seekProm
    seekProm
      .then(({ seq, blockOffset }) => process.nextTick(cb, null, seq, blockOffset))
      .catch(err => process.nextTick(cb, err))
  }

  has (seq, cb) {
    return maybe(cb, this._has(seq))
  }

  createReadStream (opts) {
    return new ReadStream(this, opts)
  }

  createWriteStream (opts) {
    return new WriteStream(this, opts)
  }

  download (range, cb) {
    if (typeof range === 'number') range = { start: range, end: range + 1}
    if (Array.isArray(range)) range = { blocks: range }

    // much easier to run this in the client due to pbuf defaults
    if (range.blocks && typeof range.start !== 'number') {
      let min = -1
      let max = 0

      for (let i = 0; i < range.blocks.length; i++) {
        const blk = range.blocks[i]
        if (min === -1 || blk < min) min = blk
        if (blk >= max) max = blk + 1
      }

      range.start = min === -1 ? 0 : min
      range.end = max
    }
    if (range.end === -1) range.end = 0 // means the same

    const resourceId = this._sessions.createResourceId()

    const prom = this._client.hypercore.download({ ...range, id: this._id, resourceId })
    prom.catch(noop) // optional promise due to the hypercore signature
    prom.resourceId = resourceId

    maybe(cb, prom)
    return prom // always return prom as that one is the "cancel" token
  }

  undownload (dl, cb) {
    if (typeof dl.resourceId !== 'number') throw new Error('Must pass a download return value')
    const prom = this._client.hypercore.undownload({ id: this._id, resourceId: dl.resourceId })
    prom.catch(noop) // optional promise due to the hypercore signature
    return maybe(cb, prom)
  }

  // TODO: Unimplemented methods

  registerExtension () {
  }

  replicate () {
    throw new Error('Cannot call replicate on a RemoteHyperdrive')
  }
}

class RemoteHypercorePeer {
  constructor (type, remoteAddress, remotePublicKey) {
    this.type = type
    this.remoteAddress = remoteAddress
    this.remotePublicKey = remotePublicKey
  }
}

function noop () {}
