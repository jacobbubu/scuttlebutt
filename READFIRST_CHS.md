学习笔记
========

概述
----

在任意 n 个节点之间，通过任何可能的连接方式保持状态（数据）的一致性，无论从算法角度还是实现角度来看都不是一个简单的任务。

Scuttlebutt 做到了。严格说，是 Node.JS 社区把这件事做到了。

算法的基础是 http://www.cs.cornell.edu/home/rvr/papers/flowgossip.pdf。

[dominictarr](https://github.com/dominictarr?tab=repositories) 在 [Scuttlebutt Repo.](https://github.com/dominictarr/scuttlebutt) 中实现了该算法。

得益于 [Node.JS Stream](http://www.nodejs.org/api/stream.html)，连接问题也被解决了。

不同的开发者也贡献了不同的数据结构实现（参见源 READMEME.markdown），这样，复杂拓扑下的状态同步就不再是一个难题了。

如果仅仅在 Node.JS 或者 Javascript 覆盖的世界中，我只要直接把这些东西拿来用就好了。不过，起码在我的项目中，我还需要考虑和 iOS 进行同步的问题。因此，我就必须了解协议的细节，实现的细节，这样才可能在 iOS 中找到最简单的实现方法。

由于原文没有描述算法，因此先读本文再读 README，会更容易理解。代码中我也加了注释，很多细节毕竟只能靠读代码来了解。

算法概述
--------

我们先来定义一些概念：

### Model ###

需要同步的数据结构我们称为 Model（这里套用了项目中的一个 Hash 对象的 Scuttlebutt 实现的名字），数据结构可以简单到一个单值，或是一个 Hash Object，Array，Queue... 你可以根据自己的需要实现自定义的数据结构，实现诸如配置同步、健康监测、聊天室、协同编辑（Operational Transformation）等功能。

需要同步的 Model 之间相互连接，其拓扑结构是不确定的。例如：

```
    Model-1 <-------> Model-2  <-----> Model-3  <-----> Model-5 <------+
                        ^                                              |
                        |                                              V
                        +---------> Model-4  <-----> Model-6 <---> Model-7
```

### Stream ###

Model 之间的连接是双向的。在本项目中，每一个相互连接都是一个 Duplex Stream，即接收数据，也发送数据。在上图中，Model-1 有一个和 Model-2 的 Duplex Stream。Model-2 则包含两个 Stream，一个用于连接 Model-3，另外一个用于连接 Model-4。

所以我们可以看到，每一个 Model 可能包含 0 个或多个 Stream，依赖于它需要和多少其他 Model 进行同步。

```
                  +---> BrowserModel-1
                  |
      WebModel <------> BrowserModel-2
                  |       .
                  +       .
                  +---> BrowserModel-N
```

像上图的场景，如果需要将 WebModel 上的数据同步到 N 个 BrowserModel，在 WebModel 这端会建立 N 个 Dulpex Stream。而每个 BrowserModel 则需要建立一个和 WebModel 连接的 Duplex Stream。

Node.JS 的 Stream 是协议无关的。你可以用某种 WebSocket 来做 Stream (例如：[shoe](https://github.com/substack/shoe), 或者 [websocket-stream](https://github.com/maxogden/websocket-stream))，或者干脆就是原厂的 tcp stream，或者实现一个复用既有连接的 stream，只要能被 pipe 来 pipe 去就好:)。

### Gossip ###

每个 Model 的状态都可能在不断地变化。一部分的变化来自于 Model 自身的 update，还有一部分变化“来自于其他 Model”。这个“来自于其他 Model”的意思，并不是指仅仅来自于和我有直接联系的 Stream，也包括间接联系的其他 Model 产生的 update。

每个 Model 即肩负着向同步对端发送自己的 update 的义务，也必须传递间接收到的 update，既要“造谣”，也要“传谣”。这也是为什么论文中用 Gossip Protocol 来命名这套消息和流控机制的原因。

每个 update 的 tuple 的格式为：[value, ts, id]

* value: 变化的值，由 Model 来定义其含义
* ts: 时间戳，每个 Model 根据自己的时钟生成的
* sourceId: 每个 Model 的标识符，在相互连接的环境中具有唯一性

### Vecrot Clock ###

下面举例说明整个流程：

```
  Model-1 <---> Model-2 <---> Model-3
```

上图中，Model-1 和 Model-2 之间建立相互连接的 Stream；Model-2 和 Model-3 之间建立相互连接的 Stream。

当 Stream 建立时，每个 Model 都会向对端发送自己拥有的 [Vector Clock](http://en.wikipedia.org/wiki/Vector_clock)。

Vector Clock 是每一个 Model 所能了解到的（根据 update 记录的 [ts, sourceId]）外部其他 Model 的最新状态，这个状态对象的格式为：

```
{
  sourceId-1: ts-1,
  sourceId-2: ts-2,
  ...
  sourceId-N: ts-N
}
```

无论其原本自身状态如何，每两个 Model一旦建立起新的 Stream 连接，首先要做的就是交换其 Vector Clock。交换之后，Model 就会根据收到的 Vector Clock 和自己保存的变化历史，生成一个对方需要的 update 数组（称为 History），然后将该 History 发送到对端。收到 update 数组的 Model 将依次判断是否需要更新自身的数据状态，更新完成后，也把自己的 Vector Clock 更新到最新状态。

随后，如果 Stream 继续保持的状态下，两个 Model 不仅交换自身产生的 update，也负责将传播他们所连接的其他 Model 产生的 update。如上图，Model-1 也会收到 Model-3 的 update，虽然是由 Model2 转发过来的。这些 update 也会触发每个 Model 对其 Vector Clock 的更新。

### 流量 ###

整个同步网络中的流量大小，和 Vector Clock 大小相关，以及 History 的大小。而 Vector Clock 的大小，不是和整个网络中 Model 的数量相关，而是和整个网络中产生了 update 的 Model 的数量相关。因此，假设在你的网络中，WebModel 需要把数据同步给成千上万的只读的 BrowserModel，那么其 Vecrot Clock 也只有 WebModel 这一项。

如果我们需要实现一个聊天室，那么 Vector Clock 的大小就是聊天室中说过话的客户端。

至于 History 的大小，则是和具体业务相关的。如果你需要同步的 Model 是一个配置文件，那么 History 也仅需要表示配置文件的最后状态即可；如果你需要同步的 Model 是聊天室，那么 History 则是某个客户端上一次退出聊天室到这次进入时的消息数量。

### 子类 ###

子类至少需要实现两个方法：

* history：根据传入的 Vectory Clock 和自身的数据状态，生成对端需要的更新数据
* applyUpdates: 将自身产生或收到的 update 保存到自身状态中。父类会把 update 传播给其他相连的 stream

### 后续 ###

请继续阅读原作者的 [README.markdown](./README.markdown) 以及源代码和相关的子类。