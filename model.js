// 这个例子是一个 Key/Value 的 Scuttlebutt 的实现

var Scuttlebutt = require('./index')
var inherits = require('util').inherits
var each = require('iterate').each
var u = require('./util')

module.exports = Model

inherits(Model, Scuttlebutt)

// this.store 用来存储每一个 key 的最新的 update tuple
// update = this.store[key]
// value = update[0], ts = update[1], source = update[2], sign = update[3]
// value 记录一次 update 的 [key,value]
// key = value[0], value = value[1]
function Model (opts) {
  if(!(this instanceof Model)) return new Model(opts)
  Scuttlebutt.call(this, opts)
  this.store = {}
}

var m = Model.prototype

// 设置 k = v 的同时，记录变更历史。
// 在这里，父类完成时间戳、sourceId的添加，启动Value校验...
// 但是实际的校验逻辑和历史保存在子类中
m.set = function (k, v) {
  if(k==='__proto__') return u.protoIsIllegal(this)
  this.localUpdate([k, v])
  return this
}

// this.store[k][0][1] 是指对于 key = k 的属性，其最新一个更新的值
m.get = function (k) {
  if(k==='__proto__') return u.protoIsIllegal(this)
  if(this.store[k])
    return this.store[k][0][1]
}

m.keys = function () {
  var a = []
  for (var k in this.store)
    a.push(k)
  return a
}

// 实现了迭代器方法，
// model.each(function (value, key, store) {})
// this.store[k][0][1] 是该 key 最新的值
// 对于 key = k, 其[0] 的格式为 [keyName, value]，因此[0][1] 对应 value
m.forEach =
m.each = function (iter) {
  for (var k in this.store)
    iter(this.store[k][0][1], k, this.store)
  return this
}

//return this history since sources.
//sources is a hash of { ID: TIMESTAMP }

// update = [value, ts, source, sign]
// model 的 value 为 [key, value]
m.applyUpdate = function (update) {
  var key = update[0][0];  // value = update[0][1]
  if('__proto__' === key) return u.protoIsIllegal(this)

  //ignore if we already have a more recent value
  // 如果当前 key 存在，并且当前值的时间戳比传入的新，则忽略这条 update
  if('undefined' !== typeof this.store[key]
    && this.store[key][1] > update[1])
    return this.emit('_remove', update)

  // 传入的 update 更新一些，因此覆盖老值。覆盖前发出通知事件
  if(this.store[key]) this.emit('_remove', this.store[key])

  this.store[key] = update

  // 一系列的变更事件
  this.emit.apply(this, ['update'].concat(update))
  this.emit('change', key, update[0][1])
  this.emit('change:'+key, update[0][1])

  return true
}

// 为每一个 source 找出其需要的 history (update数组)
// sources 是 { sourceId: ts} 对象，记录着每一个 source 同步到的时间戳
// 我们对每一个 Model 中的每一个 key 都进行一次 sources 的遍历
// 传入的 sources 对象是远端节点的 sources，我们需要以此为远端对象计算 history
m.history = function (sources) {
  var self = this
  var h = []
  each(this.store, function (e) {
    // e 是 update, u.filter
    if(u.filter(e, sources))
      h.push(e)
  })
  return u.sort(h)
}

// 类似于 Backbone，这里的 toJSON 不是生成 JSON.stringifed 之后字符串，
// 而是把 Model 转变为平的，不包含更新状态的简单Javascript 对象
// 注意，下面的实现没有把值为 null 的 key 保留下来
m.toJSON = function () {
  var o = {}, notNull = false
  for (var k in this.store) {
    var v = this.get(k)
    if(v != null)
      o[k] = this.get(k)
  }
  return o
}