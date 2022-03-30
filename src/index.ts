import { createClient, Client, MemberInfo, FriendInfo, segment, GroupInviteEvent } from "oicq"
import * as net from "net"
import * as path from "path"

/* 初始化 OICQ 客户端 */
let client: Client;
let generalInfoList: (MemberInfo | FriendInfo)[] = []
let generalDupList: string[] = []
let currentInvitation: GroupInviteEvent;

/* 修复打包后的路径错误 */
let data_dir: string;
if ("pkg" in process) {
  data_dir = path.resolve(process.execPath + '/..');
} else {
  data_dir = path.join(require.main ? require.main.path : process.cwd())
}

/* 提供有关后端的必要信息 */
const MOTD = {
    backend: "Axon",
    version: "1.0.0",
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
const j = (some: any) => {
    // console.log('O: ', some)
    return JSON.stringify(some)
}

/* 一系列常用返回 */ 
const RET_OK = j({ "status": 0 })
const RET_ERR_UNKNOWN = j({ "status": -2 })
const RET_ERR_NO_CLIENT = j({ "status": -1 })
const RET_ERR_NON_EXIST = j({ "status": -3 })
const RET_STATUS_EVENT = 1

/* 事件类别 */
const E_FRIEND_ATTENTION = 3
const E_FRIEND_MESSAGE   = 1
const E_GROUP_MESSAGE    = 2
const E_GROUP_INVITE     = 4
const E_GROUP_INCREASE   = 5
const E_GROUP_DECREASE   = 6

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

/* 根据信息获取替代昵称 */
function alternate_name(l: MemberInfo | FriendInfo): string {
    let altName

    if (generalDupList.includes(l.nickname))
	altName = l.nickname.concat('#')
	    .concat(l.user_id.toString().slice(-4))
    else
	altName = l.nickname

    return altName
}

/* 根据信息获取替代昵称 */
function alternate_name_by_id(id: number): string {
    for (let u of generalInfoList) {
	if (id === u.user_id) {
	    return alternate_name(u)
	}
    }

    return "未知用户"
}

/* 从替代昵称中获取QQ号 */
function id_from_altName(altName: string): number {
    for (let u of generalInfoList) {
	if (u.nickname === altName) {
	    return u.user_id
	}
	if (u.user_id.toString().endsWith(altName.split("#")[1])) {
	    return u.user_id
	}
    }

    return -1;
}

/* 监听事件，通过 Socket 发送 */
function hookEvent(sock: net.Socket, client: Client) {
    client.on("message.private", (e) => {
	let uinfo = client.fl.get(e.sender.user_id)
	if (!uinfo) return
	let text = ""

	e.message.forEach(msg => {
	    switch (msg.type) {
		case "text":
		    text += msg.text
		    break
		case "image":
		    text += `QQ图片：${msg.url}`
		    break
		case "face":
		    text += `[${msg.text}]`
		    break
		case "file":
		    text += `收到QQ文件（本版本不支持查看）`
		    break
		case "video":
		    text += `收到QQ视频（本版本不支持查看）`
		    break
		case "flash":
		    text += `QQ闪照：${msg.url}`
		    break
		case "poke":
		    if (!uinfo) return
		    sock.write(j({
			"status": RET_STATUS_EVENT,
			"type":   E_FRIEND_ATTENTION,
			"sender": alternate_name(uinfo),
			"time":   e.time
		    }))
	    }
	})

	if (text) {
	    sock.write(j({
		"status": RET_STATUS_EVENT,
		"type":   E_FRIEND_MESSAGE,
		"sender": alternate_name(uinfo),
		"text":   text,
		"time":   e.time
	    }))
	}
    })

    client.on("message.group", async (e) => {
	let text = ""
	
	e.message.forEach((msg) => {
	    switch (msg.type) {
		case "text":
		    text += msg.text
		    break
		case "image":
		    text += `QQ图片：${msg.url}`
		    break
		case "face":
		    text += `[${msg.text}]`
		    break
		case "file":
		    text += `收到QQ文件（本版本不支持查看）`
		    break
		case "video":
		    text += `收到QQ视频（本版本不支持查看）`
		    break
		case "at":
		    text += msg.text
		    break
		case "flash":
		    text += `QQ闪照：${msg.url}`
		    break
	    }
	})
	
	if (text) {
	    let memberList = await client.getGroupMemberList(e.group_id)
	    let memberInfo = memberList.get(e.sender.user_id)

	    if (!memberInfo) return
	    
	    sock.write(j({
		"status": RET_STATUS_EVENT,
		"type":   E_GROUP_MESSAGE,
		"sender": alternate_name(memberInfo),
		"id":     e.group_id,
		"name":   e.group_name,
		"text":   text,
		"time":   e.time
	    }))
	}
    })

    client.on("request.group.invite", (invitation) => {
	currentInvitation = invitation;
	sock.write(j({
	    "status": RET_STATUS_EVENT,
	    "type":   E_GROUP_INVITE,
	    "id":     invitation.group_id,
	    "name":   invitation.group_name,
	    "sender": alternate_name_by_id(invitation.user_id)
	}))
    })

    client.on("notice.group.increase", async (event) => {
	const memberList = await client.getGroupMemberList(event.group_id, true)
	const member = memberList.get(event.user_id)

	if (!member) return
	generalDupList = resolveMemberList(generalInfoList)

	sock.write(j({
	    "status": RET_STATUS_EVENT,
	    "type":   E_GROUP_INCREASE,
	    "name":   alternate_name(member),
	    "id":     event.group_id
	}))
    })

    client.on("notice.group.decrease", async (event) => {
	const memberList = await client.getGroupMemberList(event.group_id, true)
	const member = memberList.get(event.user_id)

	if (!member) return
	generalDupList = resolveMemberList(generalInfoList)

	sock.write(j({
	    "status": RET_STATUS_EVENT,
	    "type":   E_GROUP_DECREASE,
	    "name":   alternate_name(member),
	    "id":     event.group_id,
	    "reason": event.operator_id
	}))
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

	client = createClient(data.uin, {
	    platform: Number(data.platform),
	    data_dir
	})
	sock.write(RET_OK)
	STATE = 1
    },
    "LOGIN": (sock: net.Socket, data: any) => {
	/* 登录到 QQ 服务器，需要参数 passwd （类型为 str） */
	client.once("system.login.qrcode", () => {
	    client.logger.info("验证完成后敲击Enter继续..");
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
	client.pickFriend(id_from_altName(data.nick))
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
	client.pickGroup(data.id)
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
	client.pickFriend(id_from_altName(data.nick))
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
	for (let u of generalInfoList) {
	    if (u.user_id === Number(data.id)) {
		sock.write(j({
		    "status": 0,
		    "nickname": alternate_name(u),
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
	    const altName = alternate_name(m)
	    nameList.push(altName)
	    if (m.role === "owner")
		owner = altName
	    else if (m.role === "admin")
		adminList.push(altName)
	}

	if (!owner || !adminList || !memberList) {
	    sock.write(RET_ERR_NON_EXIST)
	    return;
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
	let nameList = []

	for (let m of memberList.values())
	    nameList.push(alternate_name(m))

	sock.write(j({
	    "status": 0,
	    "list": nameList
	}))

    },
    "GLIST": async (sock: net.Socket, _:any) => {
	/* 获取群聊列表 */
	if (!checkClient(sock, client))
	    return
	let idList = []
	let nameList = []

	for (let m of client.gl.values()) {
	    nameList.push(m.group_name)
	    idList.push(m.group_id)
	}

	sock.write(j({
	    "status": 0,
	    "namelist": nameList,
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
		"id": finalId,
		"sex": sex 
	    }))
	}
    },
    "APPROVE": async (sock: net.Socket, _: any) => {
	/* 接受一个邀请 */
	if (!currentInvitation) {
	    sock.write(RET_ERR_NON_EXIST)
	}
	currentInvitation.approve(true).then(() => {
	    sock.write(RET_OK)
	}).catch(() => {
	    sock.write(RET_ERR_UNKNOWN)
	})
    },
    "REFUSE": async (sock: net.Socket, _: any) => {
	/* 拒绝一个邀请 */
	if (!currentInvitation) {
	    sock.write(RET_ERR_NON_EXIST)
	}
	currentInvitation.approve(false).then(() => {
	    sock.write(RET_OK)
	}).catch(() => {
	    sock.write(RET_ERR_UNKNOWN)
	})
    },
    "STATUS": async (sock: net.Socket, data: any) => {
	/* 更改状态 */
	switch (data.status) {
	    case "busy":
		client.setOnlineStatus(50)
		sock.write(RET_OK)
		return
	    case "online":
		client.setOnlineStatus(11)
		sock.write(RET_OK)
		return
	    case "invisible":
		client.setOnlineStatus(41)
		sock.write(RET_OK)
		return
	}

	sock.write(RET_ERR_UNKNOWN)
    }
}

const server = net.createServer((sock) => {
    sock.on("error", (err) => console.log(err))

    sock.on('data', (data: Buffer) => {
	let parsedData: any;
	try { parsedData = JSON.parse(data.toString()) }
	catch (e) {
	    console.log("JSON 解析发生错误：", e)
	    return
	}
	/* 调用对应的函数 */
	// console.log('R:', parsedData)
	try { commandList[parsedData.command](sock, parsedData) }
	catch (e) { console.log("调用命令时发生错误：", e) }
    })

    sock.on('close', (_) => {
	if (STATE === 2) {
	    client.logout(false)
	    client.removeAllListeners()
	}

	STATE = 0
	sock.destroy();
    })
})

server.listen(PORT, HOST)
