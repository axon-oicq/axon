import { createClient, Client, MemberInfo, FriendInfo, segment } from "oicq"
import * as net from "net"

/* 初始化 OICQ 客户端 */
let client: Client;
let generalInfoList: (MemberInfo | FriendInfo)[] = []
let generalDupList: string[] = []

/* 提供有关后端的必要信息 */
const MOTD = {
    backend: "Axon",
    version: "0.0.2",
    status: 0
}

const HOST = '127.0.0.1'
const PORT = 9999

/**
 * 0: 需要初始化
 * 1: 需要登录
 * 2: 登录完成
 */
let STATE = 0;

/* 函数别名，方便转换 */
const j = JSON.stringify

/* 一系列常用返回 */
const RET_OK = j({ "status": 0 })
const RET_ERR_UNKNOWN = j({ "status": -2 })
const RET_ERR_NO_CLIENT = j({ "status": -1 })
const RET_ERR_NON_EXIST = j({ "status": -3 })
const RET_STATUS_EVENT = 1

/* 事件类别 */
const E_FRIEND_MESSAGE = 1
const E_GROUP_MESSAGE  = 2

/* 返回列表中，昵称相同的人的昵称 */
function resolveMemberList(l: Array<MemberInfo | FriendInfo>): string[] {
    let allNames: string[] = []
    let ret: string[] = []

    l.forEach((e) => {
	allNames.push(e.nickname)
    })
    
    ret =  allNames.filter((x, i, self) => {
	return self.indexOf(x) === i && self.lastIndexOf(x) !== i
    })
    allNames = []
    return ret
}

/* 检查客户端是否存在 */
function checkClient(sock: net.Socket, client: Client | undefined) {
    if (!client) {
	sock.write(RET_ERR_NO_CLIENT)
	return false
    }
    return true
}

/* 监听事件，通过 Socket 发送 */
function hookEvent(sock: net.Socket, client: Client) {
    client.on("message.private", (e) => {
	console.log(e)
	let text = ""
	
	e.message.forEach((msg) => {
	    if (msg.type === "text") {
		text += msg.text
	    }
	})

	if (text !== "") {
	    sock.write(j({
		"status": RET_STATUS_EVENT,
		"type": E_FRIEND_MESSAGE,
		"sender": e.from_id,
		"text": text,
		"time": e.time
	    }))
	}
    })
    client.on("message.group", async (e) => {
	let text = ""
	
	e.message.forEach((msg) => {
	    if (msg.type === "text") {
		text += msg.text
	    }
	})
	
	if (text !== "") {
	    let memberList = await client.getGroupMemberList(e.group_id)
	    let memberInfo = memberList.get(e.sender.user_id)
	    let altName

	    if (!memberInfo)
		return

	    if (generalDupList.includes(memberInfo.nickname))
		altName = memberInfo.nickname.concat('#')
		    .concat(memberInfo.user_id.toString().slice(-4))
	    else
		altName = memberInfo.nickname
	    
	    sock.write(j({
		"status": RET_STATUS_EVENT,
		"type": E_GROUP_MESSAGE,
		"sender": altName,
		"id": e.group_id,
		"text": text,
		"time": e.time
	    }))
	}
    })
}


const commandList: any =
{
    "HELO": (sock: net.Socket, _: any) => sock.write(j(MOTD)),
    "STATE": (sock: net.Socket, _: any) => {
	/* 查询 OICQ 状态，有关状态的定义在开头 */
	sock.write(j({ "status": 0, "state": STATE }))
    },
    "INIT": (sock: net.Socket, data: any) => {
	/* 初始化 OICQ 客户端，需要参数 uin （类型为 int/str） */
	generalInfoList = []
	client = createClient(data.uin)
	sock.write(RET_OK)
	STATE = 1
    },
    "LOGIN": (sock: net.Socket, data: any) => {
	/* 登录到 QQ 服务器，需要参数 passwd （类型为 str） */
	client.once("system.login.qrcode", () => {
            process.stdin.once("data", () => {
		client.login()
            })
	})
	client.once("system.login.device", () => {
            client.logger.info("验证完成后敲击Enter继续..");
            process.stdin.once("data", () => {
		client.login()
            })
	})
	client?.login(data.passwd).then(() => {
	    client.once("system.online", () => {
		/* 生成重复昵称列表 */
		let promises = []
		for (let g of client.gl.values()) {
		    promises.push(client.getGroupMemberList(g.group_id))
		}
		/* 等待生成完成 */
		Promise.all(promises).then((groupMemberListList) => {
		    for (let groupMemberList of groupMemberListList)
			generalInfoList = generalInfoList.concat(
			    Array.from(groupMemberList.values())
			)
		    generalInfoList = generalInfoList.concat(Array.from(client.fl.values()))
		    generalDupList = resolveMemberList(generalInfoList)
		    /* 回复 */
		    STATE = 2
		    sock.write(RET_OK)
		    client.removeAllListeners("system.login.error")
		    hookEvent(sock, client)
		    return []
		})
	    });

	    client.once("system.login.error", () => {
		sock.write(RET_ERR_UNKNOWN)
		client.removeAllListeners("system.online")
	    });
	})
    },
    "UDUMP": (sock: net.Socket, _: any ) => {
	/* 输出 OICQ 客户端中的所有好友 ID */
	if (!checkClient(sock, client))
	    return
	sock.write(j({ "status": 0, "fl": Array.from(client.fl.keys()) }))
    },
    "GDUMP": (sock: net.Socket, _: any ) => {
	/* 输出 OICQ 客户端中的所有群 ID */
	if (!checkClient(sock, client))
	    return
	sock.write(JSON.stringify({ "status": 0, "gl": Array.from(client.gl.keys()) }))
    },
    "USEND": (sock: net.Socket, data: any) => {
	/* 向一个好友发送消息，需要参数 uid 和 message （类型为 MessageElm 或 str） */
	if (!checkClient(sock, client))
	    return
	client.pickFriend(data.uid)
	    .sendMsg(data.message).then(() => {
		sock.write(RET_OK)
	    }).catch((e) => {
		console.log(e)
		sock.write(RET_ERR_UNKNOWN)
	    })
    },
    "GSEND": (sock: net.Socket, data: any) => {
	/* 向一个群发送消息，需要参数 gid 和 message （类型为 MessageElm 或 str） */
	if (!checkClient(sock, client))
	    return
	client.pickGroup(data.gid)
	    .sendMsg(data.message).then(() => {
		sock.write(RET_OK)
	    }).catch((e) => {
		console.log(e)
		sock.write(RET_ERR_UNKNOWN)
	    })
    },
    "USEND_SHAKE": (sock: net.Socket, data: any) => {
	/* 向一个好友发送窗口抖动，需要参数 uid */
	if (!checkClient(sock, client))
	    return
	client.pickFriend(data.uid)
	    .sendMsg(segment.poke(0)).then(() => {
		sock.write(RET_OK)
	    }).catch((e) => {
		console.log(e)
		sock.write(RET_ERR_UNKNOWN)
	    })
    },
    "GINFO": (sock: net.Socket, data: any) => {
	/* 获取群信息 */
	if (!checkClient(sock, client))
	    return
	let ginfo = client.gl.get(Number(data.id))
	if (!ginfo) {
	    sock.write(RET_ERR_NON_EXIST)
	    return
	}
	sock.write(j({
	    "status": 0,
	    "name": ginfo.group_name
	}))
    },
    "IDINFO": async (sock: net.Socket, data: any) => {
	/* 根据替代昵称获取好友/ */
	if (!checkClient(sock, client))
	    return
	let altName
	for (let u of generalInfoList) {
	    if (u.user_id === Number(data.uid)) {
		
		if (generalDupList.includes(u.nickname))
		    altName = u.nickname.concat('#')
			.concat(u.user_id.toString().slice(-4))
		else
		    altName = u.nickname

		sock.write(j({
		    "status": 0,
		    "nickname": altName,
		    "sex": u.sex,
		    "uid": u.user_id
		}))
		return
	    }
	}
	sock.write(RET_ERR_NON_EXIST)
    },
    "GMLIST": async (sock: net.Socket, data: any) => {
	/* 获取群成员列表 */
	if (!checkClient(sock, client))
	    return
	let memberList = await client.getGroupMemberList(data.id)
	let nameList = []

	let owner, adminList = []

	for (let m of memberList.values())
	{
	    if (generalDupList.includes(m.nickname)) {
		const altName = m.nickname.concat('#')
		    .concat(m.user_id.toString().slice(-4))
		nameList.push(altName)
		if (m.role === "owner")
		    owner = altName
		else if (m.role === "admin")
		    adminList.push(altName)
	    } else {
		nameList.push(m.nickname)
		if (m.role === "owner")
		    owner = m.nickname
		else if (m.role === "admin")
		    adminList.push(m.nickname)
	    }
	}

	sock.write(j({
	    "status": 0,
	    "list": nameList,
	    "owner": owner,
	    "admin": adminList
	}))
    },
    "FLIST": async (sock: net.Socket, _: any) => {
	/* 获取好友列表 */
	if (!checkClient(sock, client))
	    return
	let memberList = client.getFriendList()
	let nameList = [], idList = []

	for (let m of memberList.values())
	{
	    if (generalDupList.includes(m.nickname)) {
		const altName = m.nickname.concat('#')
		    .concat(m.user_id.toString().slice(-4))
		nameList.push(altName)
	    } else
		nameList.push(m.nickname)
	    idList.push(m.user_id)
	}

	sock.write(j({
	    "status": 0,
	    "list": nameList,
	    "idlist": idList
	}))

    },
    "WHOAMI": async (sock: net.Socket, _: any) => {
	/* 获取我的名字 */
	if (!checkClient(sock, client))
	    return

	sock.write(j({
	    "status": 0,
	    "name": client.nickname
	}))
    },
    "LOOKUP": async (sock: net.Socket, data: any) => {
	/* 根据昵称查询一个用户 */
	if (!checkClient(sock, client))
	    return
	let finalId, sex;
	/* 有关替代昵称见 RULES 文件 */
	for (let u of generalInfoList) {
	    if (u.nickname === data.nickname) {
		finalId = u.user_id
		sex = u.sex
		break
	    }
	    if (u.user_id.toString().endsWith(data.nickname.split("#")[1])) {
		finalId = u.user_id
		sex = u.sex
		break
	    }
	}
	if (!finalId) {
	    sock.write(RET_ERR_NON_EXIST)
	} else {
	    sock.write(j({
		"status": 0,
		"uid": finalId,
		"sex": sex 
	    }))
	}
    }
}

const server = net.createServer((sock) => {
    sock.on('data', (data: Buffer) => {
	let parsedData: any;
	try { parsedData = JSON.parse(data.toString()) }
	catch (e) {
	    console.log("JSON 解析发生错误：", e)
	    return
	}
	/* 调用对应的函数 */
	try { commandList[parsedData.command](sock, parsedData) }
	catch (e) { console.log("调用命令时发生错误：", e) }
    })

    sock.on('close', (_) => {
	if (STATE === 2) {
	    client.logout(false)
	}

	STATE = 0
    })
})

server.on("error", (err) => console.log(err))

server.listen(PORT, HOST)
