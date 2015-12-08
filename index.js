var EventEmitter = require('events').EventEmitter
var i = require('iterate')
var duplex = require('duplex')
var inherits = require('util').inherits
var serializer = require('stream-serializer')
var u = require('./util')
var timestamp = require('monotonic-timestamp')

exports =
module.exports = Scuttlebutt

exports.createID = u.createID
exports.updateIsRecent = u.filter
exports.filter = u.filter
exports.timestamp = timestamp

function dutyOfSubclass() {
  throw new Error('method must be implemented by subclass')
}

//  对传入的 update 的简单数据验证
function validate (data) {
  if(!(Array.isArray(data)
    && 'string' === typeof data[2]
    && '__proto__'     !== data[2] //THIS WOULD BREAK STUFF
    && 'number' === typeof data[1]
  )) return false

  return true
}

inherits (Scuttlebutt, EventEmitter)

function Scuttlebutt (opts) {

  if(!(this instanceof Scuttlebutt)) return new Scuttlebutt(opts)
  var id = 'string' === typeof opts ? opts : opts && opts.id
  // this.sources 就是本对象维护的 Vector Clock
  // 其格式为 { sourceId1: ts1, sourceId2: ts2...}
  // this.sources 的内容是根据本对象收到的 update 积累而来
  this.sources = {}
  this.setMaxListeners(Number.MAX_VALUE)
  // count how many other instances we are replicating to.
  // this._streams 维护了当前对象需要 pipe 的 Stream 的数量
  this._streams = 0
  if(opts && opts.sign && opts.verify) {
    //  缺省的 id 是一个随机数，当然你可以用诸如 uuid 之类的 id
    this.setId(opts.id || opts.createId())

    //  现实环境中传递消息是需要考虑“坏人”的
    // security.js 中有实现 sign 和 verify 的例子
    // 例子中，每个 source 都都拥有相同的 private/public keys，
    // 用来给发出的 update 签名，以及校验收到的 update。
    // 如果 source 一方是浏览器，上述方法就不行了，可以借助于链路层(https)安全来保证
    this._sign   = opts.sign
    this._verify = opts.verify
  } else {
    this.setId(id || u.createId())
  }
}

var sb = Scuttlebutt.prototype

var emit = EventEmitter.prototype.emit

// 当收到来自于其他 source 的更新数据时，子类负责将数据同步到自己的数据结构中。
sb.applyUpdate = dutyOfSubclass

// 当需要将子类所掌握的更新历史同步到其他 source 时，需要先从子类获取 history
sb.history     = dutyOfSubclass

// 在本地记录一个变更事务。trx 代表一个变更值，由子类定义其含义
// this._update 构造一个 update 对象，然后通过事件触发该 update 在各个相连的 stream 中发送
// 最后，通过子类的 applyUpdates 也更新子类自身的内部状态
sb.localUpdate = function (trx) {
  this._update([trx, timestamp(), this.id])
  return this
}

// _update 方法不仅仅被本 source 的 localUpdate 调用，也受同步过来的 gossip 的影响
// 因此 sourceId 由外部传入
// 数据有效性通过构造的时传入的 opts._verify 常见来校验
// update记录的格式为: [value, ts, sourceId]
sb._update = function (update) {
  //validated when it comes into the stream
  var ts = update[1]        // 数组第二个参数是时间戳
  var source = update[2]    // Source Id

  //if this message is old for it's source, ignore it. it's out of
  //order. each node must emit it's changes in order!
  //emit an 'old_data' event because i'll want to track how many
  //unnecessary messages are sent.

  // ts 仅在一个 source 内才有意义（不同的 source 的时钟未必一致）
  // 如果发现传入的 [ts, sourceId] 比保存的 [ts, sourceId] 新，才会产生后续的更新
  // 否则触发事件后丢弃
  // 子类可以确定的是，只会收到某个 source 的最新的 update
  // 父类发出的 old_data 事件可以帮助我们跟踪有多少无效的更新被传递
  var latest = this.sources[source]
  if(latest && latest >= ts)
    return emit.call(this, 'old_data', update), false

  // 父类的 sources 中，为每个 source 记录了最新的时间戳
  this.sources[source] = ts

  var self = this

  // 传入的更新数据可以被校验。无论校验成功与否，都会触发对应的事件
  // 如果数据没有问题，则调用子类的 applyUpdate 完成数据的合并
  function didVerification (err, verified) {

    // I'm not sure how what should happen if a async verification
    // errors. if it's an key not found - that is a verification fail,
    // not a error. if it's genunie error, really you should queue and
    // try again? or replay the message later
    // -- this should be done my the security plugin though, not scuttlebutt.

    if(err)
      return emit.call(self, 'error', err)

    if(!verified)
      return emit.call(self, 'unverified_data', update)

    // check if this message is older than
    // the value we already have.
    // do nothing if so
    // emit an 'old_data' event because i'll want to track how many
    // unnecessary messages are sent.

    // 把 update 送给子类
    // 父类并不关心子类是如何根据 update 来合并其内部状态的
    // 每一个相连的 Stream 都会监听 _update 事件，一旦收到该事件，则会触发发送同步消息到对端
    if(self.applyUpdate(update))
      emit.call(self, '_update', update) //write to stream.
  }

  // 仅对外部传入的 update 进行校验
  // 无论外部传入的 update，还是自己的 update，都通过 didVerification
  // 调用子类的 appleyUpdates 进行内部状态更新
  // 更新后发出 _update 事件，从而触发各个 stream 的发送动作
  if(source !== this.id) {
    if(this._verify)
      // 如果子类配置了自己的 verifier，那么执行子类的
      // 子类执行完后可调用（最好如此）父类的传入的 didVerification
      this._verify(update, didVerification)
    else
      // 如果没有配置校验方法，则直接 applyUpdates。
      didVerification(null, true)
  } else {
    if(this._sign) {
      // could make this async easily enough.
      // 如果配置了签名插件，update 数组的第四个值是签名校验结果
      update[3] = this._sign(update)
    }
    didVerification(null, true)
  }

  return true
}

// 一个 Scuttlebutt 为每一个同步的 source 建立一个 stream
// 以及标识该 stream 是只读，只写还是可读写的
sb.createStream = function (opts) {
  var self = this
  // the sources for the remote end.
  // 每一个 stream 只关心对端的 sources
  var sources = {}, other
  var syncSent = false, syncRecv = false

  // Scuttlebutt 内部的 Stream 计数
  this._streams ++

  opts = opts || {}

  // 下面这几行中，outer 是真正返回给调用者的 stream
  // outer 封装了一个 全双工的 stream 的实现 d
  // outer 的作用是让这个全双工的 stream 采用换行符分割的 JSON 编码方式
  var d = duplex()
  d.name = opts.name
  var outer = serializer(opts && opts.wrapper)(d)
  outer.inner = d

  // 当前 Scuttlebutt 是否可读写
  // 双工和可读写是两个概念
  // 双工意味着 Scuttlebutt 必须尽到连接的义务，例如：生成 History 和接收或转发 didget
  // 只读则意味着其内部状态是否会随着收到的 update 而更新
  d.writable = opts.writable !== false
  d.readable = opts.readable !== false

  syncRecv   = !d.writable
  syncSent   = !d.readable

  var tail = opts.tail !== false //default to tail=true

  function start (data) {
    //when the digest is recieved from the other end,
    //send the history.
    //merge with the current list of sources.
    if (!data || !data.clock) {
        d.emit('error');
        return d._end()
    }

    sources = data.clock

    // d._data 方法用来发送数据
    // 下面这句是根据收到的 digest ，生成特定的 history 发送出去
    // 由于每一个 Node 手里的 sources 的状态是不同的
    i.each(self.history(sources), function (data) {d._data(data)})

    //the _update listener must be set after the history is queued.
    //otherwise there is a race between the first client message
    //and the next update (which may come in on another stream)
    //this problem will probably not be encountered until you have
    //thousands of scuttlebutts.

    // Stream 在这句之后，开始监听 Scuttlebutt 的变化
    // 只有在子类的 applyUpdates 执行完成后，该事件才会被发送
    self.on('_update', onUpdate)

    // 在 history 发送完成后，向对方发送 SYNC 消息，
    // 这样对端就知道哪些是 history，哪些是后续的 update
    d._data('SYNC')
    syncSent = true
    //when we have sent all history
    outer.emit('header', data)
    outer.emit('syncSent')
    //when we have recieved all history
    //emit 'synced' when this stream has synced.
    if(syncRecv) outer.emit('sync'), outer.emit('synced')
    // 结束当前的发送工作，进入 drain 状态。
    if(!tail) d._end()
  }

  d
    .on('_data', function (data) {
      //if it's an array, it's an update.
      if(Array.isArray(data)) {
        //check whether we are accepting writes.
        // 如果 stream 是只读的，则忽略传递进来的 update
        if(!d.writable)
          return
        if(validate(data))
          return self._update(data)
      }
      //if it's an object, it's a scuttlebut digest.
      // digest 就是 vector clock，也就是 this.sources
      else if('object' === typeof data && data)
        start(data)
      else if('string' === typeof data && data == 'SYNC') {
        syncRecv = true
        outer.emit('syncRecieved')
        if(syncSent) outer.emit('sync'), outer.emit('synced')
      }
    }).on('_end', function () {
      d._end()
    })
    .on('close', function () {
      self.removeListener('_update', onUpdate)
      self.removeListener('dispose', dispose)
      //emit the number of streams that are remaining...
      //this will be used for memory management...
      self._streams --
      emit.call(self, 'unstream', self._streams)
    })

  if(opts && opts.tail === false) {
    outer.on('sync', function () {
      process.nextTick(function () {
        d._end()
      })
    })
  }
  function onUpdate (update) { //value, source, ts
    // validate 完成出站校验，无论这个 update 是我自己产生的，
    // 还是其他 source 发来的，出站前都要校验
    // u.filter 则是检查，对端的 source 是否需要接收该更新
    // 这是通过确定 update 中的 [ts, sourceId] 是不是比 sources[sourceId].ts 更新来绝定的
    if(!validate(update) || !u.filter(update, sources))
      return

    d._data(update)

    //really, this should happen before emitting.
    var ts = update[1]
    var source = update[2]
    sources[source] = ts
  }

  function dispose () {
    d.end()
  }

  // Stream 建立之后，需要发送自己的摘要数据(vector clock)给对端
  // meta 的是用来在 stream 上附带信息
  var outgoing = { id : self.id, clock : self.sources }

  if (opts && opts.meta) outgoing.meta = opts.meta

  if(d.readable) {
    d._data(outgoing)
    if(!d.writable && !opts.clock)
      start({clock:{}})

  } else if (opts.sendClock) {
    //send my current clock.
    //so the other side knows what to send
    d._data(outgoing)
  }

  self.once('dispose', dispose)

  return outer
}

sb.createWriteStream = function (opts) {
  opts = opts || {}
  opts.writable = true; opts.readable = false
  return this.createStream(opts)
}

sb.createReadStream = function (opts) {
  opts = opts || {}
  opts.writable = false; opts.readable = true
  return this.createStream(opts)
}

sb.dispose = function () {
  emit.call(this, 'dispose')
}

sb.setId = function (id) {
  if('__proto__' === id) throw new Error('__proto__ is invalid id')
  if(id == null) throw new Error('null is not invalid id')
  this.id = id
  return this
}

function streamDone(stream, listener) {

  function remove () {
    stream.removeListener('end',   onDone)
    stream.removeListener('error', onDone)
    stream.removeListener('close',   onDone)
  }
  function onDone (arg) {
    remove()
    listener.call(this, arg)
  }

  //this makes emitter.removeListener(event, listener) still work
  onDone.listener = listener

  stream.on('end',   onDone)
  stream.on('error', onDone)
  stream.on('close', onDone)
}

//create another instance of this scuttlebutt,
//that is in sync and attached to this instance.
sb.clone = function () {
  var A = this
  var B = new (A.constructor)
  B.setId(A.id) //same id. think this will work...

  // 直接修改 A 的被 clone 的数量
  A._clones = (A._clones || 0) + 1

  // 既然不通过网络，就无需 JSON 序列化了
  var a = A.createStream({wrapper: 'raw'})
  var b = B.createStream({wrapper: 'raw'})

  //all updates must be sync, so make sure pause never happens.
  a.pause = b.pause = function noop(){}

  streamDone(b, function () {
    A._clones--
    emit.call(A, 'unclone', A._clones)
  })

  a.pipe(b).pipe(a)
  //resume both streams, so that the new instance is brought up to date immediately.
  a.resume()
  b.resume()

  return B
}

