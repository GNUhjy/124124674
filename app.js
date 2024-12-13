import express from 'express'
//import https from 'httpolyglot'
import http from 'http' 
import fs from 'fs'
import path from 'path'
import { Server } from 'socket.io'
import mediasoup from 'mediasoup'
import dotenv from 'dotenv'
import session from 'express-session'

dotenv.config()

const app = express()
const __dirname = path.resolve()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 세션 코드
app.use(session({
  secret: 'process.env.SESSION_SECRET',
  resave: false,
  saveUninutialized: false,
  cookie: { secure: false }
}))

// 인증서 옵션
//const options = {
//  key: fs.readFileSync('/etc/letsencrypt/live/webrtc.n-e.kr/privkey.pem', 'utf-8'),
//  cert: fs.readFileSync('/etc/letsencrypt/live/webrtc.n-e.kr/fullchain.pem', 'utf-8')
//};

const httpServer = http.createServer(app)

// 정적 파일 제공 
app.use(express.static(path.join(__dirname, 'public')))

// 회원 정보 저장
const usersFile = path.join(__dirname, 'users.json')

// 로그인 여부 확인 미들웨어
const isAuthenticated = (req, res, next) => {
  if (req.session && req.session.username) {
    return next()
  }
  res.redirect('/login')
}

// 로그인 상태 확인 API
app.get('/api/auth/status', (req, res) => {
  if (req.session && req.session.username) {
    res.json({ loggedIn: true, username: req.session.username })
  } else {
    res.json({ loggedIn: false })
  }
})

// 메인 페이지
app.get('/', (req, res) => {
  const loggedIn = req.session && req.session.username // 로그인 상태 확인
  const username = req.session?.username || '' // 세션에 저장된 사용자 이름

  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// 로그인 페이지
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
})

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'))
})

// 방 생성 페이지
app.get('/create-room', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create-room.html'));
});

// 방 참가 페이지
app.get('/join-room', isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join-room.html'));
});

/* 회원가입 요청 처리 */
app.post('/signup', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).send("아이디와 비밀번호를 입력하세요.")
  }

  // 기존 유저 목록 불러오기
  let users = []
  if (fs.existsSync(usersFile)) {
    const data = fs.readFileSync(usersFile, 'utf-8')
    users = JSON.parse(data);
  }

  // 중복 아이디 확인
  if (users.some(user => user.username === username)) {
    return res.status(400).send('이미 존재하는 아이디입니다.')
  }

  // 새 유저 추가
  users.push({ username, password })
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2))

  res.redirect('/login')
})

// 로그인 요청 처리
app.post('/login', (req, res) => {
  console.log('Request Body:', req.body); // req.body가 어떤 값을 가지는지 출력
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).send('아이디와 비밀번호를 입력하세요.')
  }

  if (!fs.existsSync(usersFile)) {
    return res.status(400).send('등록된 유저가 없습니다.')
  }

  const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'))
  const user = users.find(user => user.username === username && user.password === password)

  if (!user) {
    return res.status(401).send('아이디 또는 비밀번호가 올바르지 않습니다.')
  }
  req.session.username = username // 세션에 사용자 정보 저장

  res.redirect('/')
})

// 로그아웃 요청 처리
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Failed to destroy session:', err);
      return res.status(500).send('Internal Server Error');
    }
    res.redirect('/'); // 로그아웃 후 메인 페이지로 리다이렉트
  });
});

app.get('/sfu/:room', isAuthenticated, (req, res) => {
  const roomName = req.params.room

  if (!rooms[roomName]) {
    return res.status(404).send(`방 "${roomName}"이 존재하지 않습니다.`)
  }

  res.sendFile(path.join(__dirname, 'public', 'sfu.html'))
})

// SFU 연결
app.use('/sfu/:room', express.static(path.join(__dirname, 'public', 'sfu')));

// HTTPS 서버 시작
httpServer.listen(8080, () => {
  console.log("listening on port 8080")
})

const io = new Server(httpServer)

const connections = io.of('/mediasoup')

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    }
  }
]

let worker
let rooms = {
  roomName1: {
    password: 'roomPassword', // 방 비밀번호
    host: 'hostSocketId', // 방 호스트의 소켓 ID
    router: {}, // Mediasoup Router 인스턴스
    peers: { // 방에 참여한 사용자들
      socketId1: { 
        transports: [], // WebRTC Transports 관련 정보
        producers: [], // 미디어 송출(Producers) 관련 정보
        consumers: [], // 미디어 수신(Consumers) 관련 정보
      },
      socketId2: {
        transports: [],
        producers: [],
        consumers: [],
      },
    },
  },
  roomName2: {
    password: 'anotherRoomPassword',
    host: 'anotherHostSocketId',
    router: {},
    peers: {},
  },
};
let peers = {}          // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []     // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []      // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []      // [ { socketId1, roomName1, consumer, }, ... ]


const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  })
  console.log(`worker pid ${worker.pid}`)

  worker.on('died', error => {
    console.error('mediasoup worker has died')
    setTimeout(() => process.exit(1), 10000)
  })

  return worker
}

worker = createWorker()

const createRoom = async (roomName, hostSocketId, password) => {
  if (rooms[roomName]) {
    throw new Error(`Room "${roomName}" already exists`);
  }

  console.log(`Creating a new room: ${roomName}`);
  try{
  const router = await worker.createRouter({ mediaCodecs });

    rooms[roomName] = {
      password,
      host: hostSocketId,
      router,
      peers: {}, // socketId별 사용자 정보 저장
      producers: {}, // producerId별 정보 저장
      consumers: {}, // consumerId별 정보 저장
      transports: {}, // transportId별 정보 저장
    };
  }catch(eror){
    console.log('라우터 생성 실패');
  }

  console.log(`Room "${roomName}" created`);
  return rooms[roomName];

};

// 방 생성 요청 처리
app.post('/api/create-room', isAuthenticated, async (req, res) => {
  const { roomName, roomPassword } = req.body;

  if (!roomName || !roomPassword) {
    return res.status(400).send('방 이름과 비밀번호를 입력해주세요.');
  }

  if (Object.keys(rooms).length >= 4) {
    console.log(Object.keys(rooms).length)
    return res.status(400).send('방 생성 제한: 최대 3개의 방만 생성할 수 있습니다.');
  }

  try {
    const room = await createRoom(roomName, req.session.username, roomPassword);
    console.log(`Room "${roomName}" created`);
    res.redirect(`/sfu/${roomName}`);
  } catch (error) {
    console.error(error.message);
    res.status(500).send('방 생성 중 오류가 발생했습니다.');
  }
});

// connection 부분 추가 
connections.on('connection', async socket => {
  console.log(`User connected: ${socket.id}`)

  socket.emit('connection-success', {
    socketId: socket.id,
  })

  const removeItems = (items, socketId, type) => {
    items.forEach(item => {
      if (item.socketId === socket.id) {
        item[type].close()
      }
    })
    items = items.filter(item => item.socketId !== socket.id)

    return items
  }

  // 클라이언트가 종료할 때
  socket.on('disconnect', async () => {
    const roomName = Object.keys(rooms).find((name) => rooms[name].peers[socket.id]);

    if (!roomName) return;

    const room = rooms[roomName];

    // 호스트인지 확인 후 방 삭제
    if (room.host === socket.id) {
      console.log(`Host ${socket.id} left. Deleting room: ${roomName}`);

      if (room.router) {
        await room.router.close();
        console.log(`Router for room "${roomName}" closed.`);
      }

      delete rooms[roomName];
    } else {
      // 참가자만 삭제
      delete room.peers[socket.id];
      console.log(`User ${socket.id} left room: ${roomName}`);
    }
  });

  socket.on('joinRoom', async ({ roomName }, callback) => {
    if (!rooms[roomName]) {
      return callback({ error: 'Room does not exist' });
    }
    const router = rooms[roomName].router;
    callback({ rtpCapabilities: router.rtpCapabilities });
    
    const room = rooms[roomName];

    // 참가자가 이미 존재하는지 확인
    if (room.peers[socket.id]) {
      return callback({ error: 'Already joined' });
    }

    // 참가자 추가
    room.peers[socket.id] = {
      transports: [],
      producers: [],
      consumers: [],
    };

    console.log(`User ${socket.id} joined room: ${roomName}`);

    // Router RTP Capabilities 전달
    callback({ rtpCapabilities: room.router.rtpCapabilities });
  });

  // socket.on('createRoom', async (callback) => {
  //   if (router === undefined) {
  //     // worker.createRouter(options)
  //     // options = { mediaCodecs, appData }
  //     // mediaCodecs -> defined above
  //     // appData -> custom application data - we are not supplying any
  //     // none of the two are required
  //     router = await worker.createRouter({ mediaCodecs, })
  //     console.log(`Router ID: ${router.id}`)
  //   }

  //   getRtpCapabilities(callback)
  // })

  // const getRtpCapabilities = (callback) => {
  //   const rtpCapabilities = router.rtpCapabilities

  //   callback({ rtpCapabilities })
  // }

  // Client emits a request to create server side Transport
  // We need to differentiate between the producer and consumer transports
  socket.on('createWebRtcTransport', async ({ consumer, roomName }, callback) => {
    console.log(roomName)
    if (!rooms[roomName]) {
      return callback({ error: '라우터 인식 실패' });
    }

    try {
      const transport = await createWebRtcTransport(rooms[roomName].router);
      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      });

      // Transport를 peers에 추가
      addTransport(transport, roomName, consumer);
    } catch (error) {
      console.log(' 여기서 ');
      callback({ error: error.message });
    }
  })

  const addTransport = (transport, roomName, consumer) => {

    transports = [
      ...transports,
      { socketId: socket.id, transport, roomName, consumer, }
    ]

    peers[socket.id] = {
      ...peers[socket.id],
      transports: [...
        transports,
        transport.id,
      ]
    }
  }

  const addProducer = (producer, roomName) => {
    producers = [
      ...producers,
      { socketId: socket.id, producer, roomName, }
    ]

    peers[socket.id] = {
      ...peers[socket.id],
      producers: [
        ...producers,
        producer.id,
      ]
    }
  }

  const addConsumer = (consumer, roomName) => {
    // add the consumer to the consumers list
    consumers = [
      ...consumers,
      { socketId: socket.id, consumer, roomName, }
    ]

    // add the consumer id to the peers list
    peers[socket.id] = {
      ...peers[socket.id],
      consumers: [
        ...consumers,
        consumer.id,
      ]
    }
  }

  socket.on('getProducers', callback => {
    //return all producer transports
    const { roomName } = peers[socket.id]

    let producerList = []
    producers.forEach(producerData => {
      if (producerData.socketId !== socket.id && producerData.roomName === roomName) {
        producerList = [...producerList, producerData.producer.id]
      }
    })

    // return the producer list back to the client
    callback(producerList)
  })

  const informConsumers = (roomName, socketId, id) => {
    console.log(socket.id, `:producer 발견, id ${id} ${roomName}`)
    // A new producer just joined
    // let all consumers to consume this producer
    producers.forEach(producerData => {
      if (producerData.socketId !== socketId && producerData.roomName === roomName) {
        const producerSocket = producerData.socketId
        // use socket to send producer id to producer
        socket.to(producerSocket).emit('new-producer', { producerId: id })
      }
    })
  }

  const getTransport = (socketId) => {
    const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer)
    return producerTransport.transport
  }

  // see client's socket.emit('transport-connect', ...)
  socket.on('transport-connect', ({ dtlsParameters }) => {
    console.log(socket.id, ': producer 연결')

    getTransport(socket.id).connect({ dtlsParameters })
  })

  // see client's socket.emit('transport-produce', ...)
  socket.on('transport-produce', async ({ kind, rtpParameters, appData, roomName }, callback) => {
    // call produce based on the prameters from the client
    const producer = await getTransport(socket.id).produce({
      kind,
      rtpParameters,
    })

    // add producer to the producers array

    addProducer(producer, roomName)

    informConsumers(roomName, socket.id, producer.id)

    console.log(socket.id, ': producer 연결됨', producer.id, producer.kind)

    producer.on('transportclose', () => {
      console.log('transport for this producer closed ')
      producer.close()
    })

    // Send back to the client the Producer's id
    callback({
      id: producer.id,
      producersExist: producers.length > 1 ? true : false
    })
  })

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`)
    const consumerTransport = transports.find(transportData => (
      transportData.consumer && transportData.transport.id == serverConsumerTransportId
    )).transport
    await consumerTransport.connect({ dtlsParameters })
  })

  socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId, roomName }, callback) => {
    try {

      const router = rooms[roomName].router
      let consumerTransport = transports.find(transportData => (
        transportData.consumer && transportData.transport.id == serverConsumerTransportId
      )).transport

      // check if the router can consume the specified producer
      if (router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities
      })) {
        // transport can now consume and return a consumer
        console.log('consume 가능')
        const consumer = await consumerTransport.consume({
          producerId: remoteProducerId,
          rtpCapabilities,
          paused: true,
        })

        consumer.on('transportclose', () => {
          console.log('transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed')
          socket.emit('producer-closed', { remoteProducerId })

          consumerTransport.close([])
          transports = transports.filter(transportData => transportData.transport.id !== consumerTransport.id)
          consumer.close()
          consumers = consumers.filter(consumerData => consumerData.consumer.id !== consumer.id)
        })

        addConsumer(consumer, roomName)

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error
        }
      })
    }
  })

  socket.on('consumer-resume', async ({ serverConsumerId }) => {
    console.log('consumer resume')
    const { consumer } = consumers.find(consumerData => consumerData.consumer.id === serverConsumerId)
    await consumer.resume()
  })
})

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: '0.0.0.0', // replace with relevant IP address
            announcedIp: '172.17.144.51',
          }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      }

      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(webRtcTransport_options)

      transport.on('dtlsstatechange', dtlsState => {
        if (dtlsState === 'closed') {
          transport.close()
        }
      })

      transport.on('close', () => {
        console.log('transport closed')
      })

      resolve(transport)

    } catch (error) {
      reject(error)
    }
  })
}


app.post('/api/join-room', isAuthenticated, (req, res) => {
  const { roomName, roomPassword } = req.body;

  if (!roomName || !roomPassword) {
    return res.status(400).send('방 이름과 비밀번호를 입력해주세요.');
  }

  const room = rooms[roomName];

  if (!room) {
    return res.status(404).send('존재하지 않는 방입니다.');
  }

  if (room.password !== roomPassword) {
    return res.status(403).send('비밀번호가 올바르지 않습니다.');
  }

  res.redirect(`/sfu/${roomName}`);
});
