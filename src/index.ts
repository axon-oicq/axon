import * as c   from './constant'
import * as i   from './interface'
import * as net from 'net'

import * as ndjson from 'ndjson'

import axios from 'axios'
import commandLineArgs from 'command-line-args'
import commandLineUsage from 'command-line-usage'

import AsyncLock from 'async-lock'
import { Client, createClient, FriendInfo, GroupInviteEvent, GroupMessageEvent,
	 MemberDecreaseEvent, MemberIncreaseEvent, MemberInfo, PrivateMessageEvent,
         MessageElem, segment, GroupRecallEvent, PrivateMessage, GroupMessage, GroupInfo } from 'oicq'


const commandOptions = [
    { name: 'host', alias: 'a', type: String,
      description: "Specify the address that axon will listen on. Default to localhost."},
    { name: 'port', alias: 'p', type: Number,
      description: "Specify the port that axon will listen on. Default to 9999."},
    { name: 'data-dir', alias: 'c', type: String,
      description: "Specify where to store the account info. Default to the same directory of the executable."},
    { name: 'debug', alias: 'd', type: Boolean,
      description: "Show the debug infomation."},
    { name: 'daemon', alias: 'D', type: Boolean,
      description: "Deamonize the process."},
    { name: 'help', alias: 'h', type: Boolean,
      description: "Print this command usage." },
]

const options = Object.assign({
    'data-dir': c.data_dir,
    'daemon': false,
    'help': false,
    'debug': false,
    'host': c.HOST,
    'port': c.PORT,
}, commandLineArgs(commandOptions))

if (options.help) {
    console.log(commandLineUsage([
	{
	    header: "Axon OICQ Wrapper",
	    content: "A socket server wrapper for oicq",
	},
	{
	    header: "Options",
	    optionList: commandOptions,
	}
    ]))
    process.exit(0)
}

if (options.daemon)
    require('daemonize-process')()

/* 函数别名，JSON 转换 */
const j = (some: object) => {
    if (options.debug)
	console.log(some)
    return JSON.stringify(some).concat("\n")
}

function fixMemberName(m: MemberInfo | GroupMessage["sender"]) {
    return (m.card === '' ? m.nickname : m.card)
}

function genName(name: string, id: number): string {
    return name.concat('#').concat(id.toString().slice(-4))
}

function resolveAcctList(l: Array<MemberInfo | FriendInfo>): string[] {
    let allNames: string[] = [], dupNames: string[] = []
    l.forEach((e) => {
	if (! ("card" in e))
	    allNames.push(e.nickname)
	else if (e.card == '')
	    allNames.push(e.nickname)
	else
	    allNames.push(e.card)
    })
    dupNames = allNames.filter((x, i, self) => {
	return self.indexOf(x) === i && self.lastIndexOf(x) !== i
    })
    return dupNames
}

function translateMessageElem(msg: MessageElem): string {
    switch (msg.type) {
	case "text":
	    return msg.text
	case "image":
	    return `QQ图片:${msg.url}`
	case "face":
	    return `[${msg.text}]`
	case "file":
	    return `收到QQ文件（本版本不支持查看）`
	case "video":
	    return `收到QQ视频（本版本不支持查看）`
	case "at":
	    return `${msg.text}`
	case "flash":
	    return `QQ闪图:${msg.url}`
	default:
	    return "未知消息类型"
    }
}

function stripRealName(a: string): string {
    return a.includes('#') ? a.split('#').slice(0, -1).join('#') : a
}

function verifyAltName(a:string): boolean {
    if (a.slice(-1) < '0' || a.slice(-1) > '9') return false
    if (a.slice(-2, -1) < '0' || a.slice(-2, -1) > '9') return false
    if (a.slice(-3, -2) < '0' || a.slice(-3, -2) > '9') return false
    if (a.slice(-4, -3) < '0' || a.slice(-4, -3) > '9') return false
    return true
}

class AxonClient {
    /* 帐号信息表与昵称重复表 */
    // acctInfoTable: Array<MemberInfo | FriendInfo> = []
    chatNickDupTable: Map<number, string[]> = new Map()
    memberInfoCache: MemberInfo[] = []
    dmNickDupTable: string[] = []
    
    client: Client | null = null
    conn: net.Socket

    invitation: GroupInviteEvent | null = null

    lock = new AsyncLock()

    /* 命令调用表 */
    callTable: any = {
	"INIT":        this._initCb,
	"LOGIN":       this._loginCb,
	"USEND":       this._usendCb,
	"USEND_IMG":   this._usendImgCb,
	"GSEND":       this._gsendCb,
	"GSEND_IMG":   this._gsendImgCb,
	"USEND_SHAKE": this._usendShakeCb,
	"GINFO":       this._ginfoCb,
	"GMLIST":      this._gmlistCb,
	"FLIST":       this._flistCb,
	"GLIST":       this._glistCb,
	"WHOAMI":      this._whoamiCb,
	"STATUS":      this._statusCb,
	"LOOKUP":      this._lookupCb,
	"GOAHEAD":     this._goAheadCb,
    }

    /* 构建单个群聊的群员昵称重复表 */
    async buildChatNickDupTable(gid: number, no_cache = false) {
	if (!no_cache && this.chatNickDupTable.has(gid)) return
	
	let nickDupList: string[] = []
	let chatMemberList = await this.client?.getGroupMemberList(gid, no_cache)
	let chatMemberListIter = chatMemberList?.values()

	if (!chatMemberListIter) return
	
	this.chatNickDupTable.delete(gid)
	nickDupList = resolveAcctList(Array.from(chatMemberListIter))
	this.chatNickDupTable.set(gid, nickDupList)
    }

    /* 构建好友昵称重复表 */
    buildDmNickDupTable() {
	if (this.dmNickDupTable.length != 0)
	    return
	
	const iter = this.client?.fl.values()
	if (!iter) return

	this.dmNickDupTable = resolveAcctList(Array.from(iter))
	this.dmNickDupTable.push('')
    }

    /* 从好友信息获取替代昵称 */
    buildFriendAltName(k: number | FriendInfo | PrivateMessage["sender"]) {
	let friendInfoList = this.client?.fl
	let dupName

	this.buildDmNickDupTable()

	if (typeof k == "number") {
	    let name = friendInfoList?.get(k)?.nickname
	    if (!name) return '幽灵用户'
	    dupName = name
	} else
	    dupName = k.nickname

	if (this.dmNickDupTable.includes(dupName)) {
	    if (typeof k == "number")
		return genName(dupName, k)
	    else
		return genName(dupName, k.user_id)
	}

	return dupName
    }

    /* 从群员信息获取替代昵称 */
    async buildChatMemberAltName(gid: number, k: GroupMessage["sender"] | MemberInfo) {
	await this.lock.acquire('retriveGroupInfo', () => this.buildChatNickDupTable(gid))

	const dupNameList = this.chatNickDupTable.get(gid)
	if (dupNameList === undefined) return "错误用户"

	if (dupNameList.includes(fixMemberName(k)))
	    return genName(fixMemberName(k), k.user_id)
	else
	    return fixMemberName(k)
    }

    /* 从替代昵称获取好友信息 */
    buildAltNameFriend(k: string) {
	const isDup = verifyAltName(k)
	const iter = this.client?.fl.values()
	if (!iter) return
	
	for (const friend of iter) {
	    if (isDup && friend.user_id.toString().endsWith(k.slice(-4))
		&& friend.remark === stripRealName(k)) return friend
	    else if (!isDup && friend.remark === k) return friend
	}
    }
    
    async _ePrivateMessage (e: PrivateMessageEvent) {
	let text: string = ''

	e.message.forEach(msg => {   
	    if (msg.type === "poke") {
		this.conn.write(j({
		    "status": c.R_STAT_EVENT,
		    "type"  : c.E_FRIEND_ATTENTION,
		    "sender": this.buildFriendAltName(e.sender),
		    "time"  : e.time,
		})); return
	    }

	    if ((msg.type == "image" || msg.type == "flash") && msg.url) {
		this.conn.write(j({
		    "status": c.R_STAT_EVENT,
		    "type"  : c.E_FRIEND_IMG_MESSAGE,
		    "sender": this.buildFriendAltName(e.sender),
		    "time"  : e.time,
		    "url"   : msg.url,
		})); return
	    }

	    text += translateMessageElem(msg)
	})

	if (text == '' || text == ' ')
	    return

	this.conn.write(j({
	    "status": c.R_STAT_EVENT,
	    "type"  : c.E_FRIEND_MESSAGE,
	    "sender": this.buildFriendAltName(e.sender),
	    "time"  : e.time,
	    "text"  : text,
	}))
    }

    async _eGroupMessage(e: GroupMessageEvent) {
	let text: string = '';

	e.message.forEach(async msg => {
	    if ((msg.type == "image" || msg.type == "flash") && msg.url) {
		if (! msg.url) return

		this.conn.write(j({
		    "status": c.R_STAT_EVENT,
		    "type"  : c.E_GROUP_IMG_MESSAGE,
		    "sender": await this.buildChatMemberAltName(e.group_id, e.sender),
		    "name"  : e.group_name,
		    "time"  : e.time,
		    "id"    : e.group_id,
		    "url"   : msg.url,
		})); return
	    }
	    text += translateMessageElem(msg)
	})

	if (text == '' || text == ' ')
	    return

	this.conn.write(j({
	    "status": c.R_STAT_EVENT,
	    "type"  : c.E_GROUP_MESSAGE,
	    "sender": await this.buildChatMemberAltName(e.group_id, e.sender),
	    "time"  : e.time,
	    "text"  : text,
	    "name"  : e.group_name,
	    "id"    : e.group_id,
	}))
    }

    async _eGroupInvite(e: GroupInviteEvent) {
	this.invitation = e;
	this.conn.write(j({
	    "status": c.R_STAT_EVENT,
	    "type"  : c.E_GROUP_INVITE,
	    "id"    : e.group_id,
	    "name"  : e.group_name,
	    "sender": "用户" /* 替代昵称 */,
	}))
    }

    async _eGroupIncrease(e: MemberIncreaseEvent) {
	const memberList = await this.client?.getGroupMemberList(e.group_id, true)
	const member = memberList?.get(e.user_id)
	if (!member) return

	/* 将新成员加入到信息表 */
	this.buildChatNickDupTable(e.group_id, true)

	this.conn.write(j({
	    "status": c.R_STAT_EVENT,
	    "type"  : c.E_GROUP_INCREASE,
	    "name"  : await this.buildChatMemberAltName(e.group_id, member),
	    "id"    : e.group_id,
	}))
    }

    async _eGroupDecrease(e: MemberDecreaseEvent) {
	this.conn.write(j({
	    "status": c.R_STAT_EVENT,
	    "type"  : c.E_GROUP_DECREASE,
	    "name"  : e.member
		? await this.buildChatMemberAltName(e.group_id, e.member)
		: "未知用户",
	    "id"    : e.group_id,
	}))
    }

    async _eGroupRecall(e: GroupRecallEvent) {
	let groupMemberList = await this.client?.getGroupMemberList(e.group_id)
	let member = groupMemberList?.get(e.user_id)
	
	if (!member) {
	    this.conn.write(c.R_ERR_NON_EXIST_J)
	    return
	}
	
	this.conn.write(j({
	    "status": c.R_STAT_EVENT,
	    "type"  : c.E_GROUP_RECALL,
	    "name": await this.buildChatMemberAltName(e.group_id, member),
	    "id"    : e.group_id
	}))
    }

    bindEventCb() {
	this.client?.on('message.private',       (e) => this.lock.acquire('cmd', () =>
	    this._ePrivateMessage.bind(this)(e)))
	this.client?.on('message.group',         (e) => this.lock.acquire('cmd', () =>
	    this._eGroupMessage.bind(this)(e)))
	this.client?.on('request.group.invite',  (e) => this.lock.acquire('cmd', () =>
	    this._eGroupInvite.bind(this)(e)))
	this.client?.on('notice.group.increase', (e) => this.lock.acquire('cmd', () =>
	    this._eGroupIncrease.bind(this)(e)))
	this.client?.on('notice.group.decrease', (e) => this.lock.acquire('cmd', () =>
	    this._eGroupDecrease.bind(this)(e)))
	this.client?.on('notice.group.recall',   (e) => this.lock.acquire('cmd', () =>
	    this._eGroupRecall.bind(this)(e)))
    }

    async _goAheadCb (_: null) {
	this.client?.login()
    }
    
    async _loginCb (info: i.LOGIN_INFO) {
	/* 添加回调 */
	this.client?.on('system.online', async () => {
	    this.conn.write(c.R_OK_J)
	    this.bindEventCb()
	})

	this.client?.on('system.login.error', async (err) => {
	    this.conn.write(j({
		"status":  c.R_ERR_UNKNOWN,
		"login":   c.L_ERROR,
		"message": err.message
	    }))
	})

	this.client?.on('system.login.qrcode', async (qr) => {
	    this.conn.write(j({
		"status": c.R_ERR_UNKNOWN,
		"login":  c.L_QRCODE,
		"data":   qr.image.toString('base64')
	    }))
	})

	this.client?.on('system.login.slider', async (slider) => {
	    this.conn.write(j({
		"status": c.R_ERR_UNKNOWN,
		"login":  c.L_SLIDER,
		"url":    slider.url
	    }))
	})

	this.client?.on('system.login.device', async (device) => {
	    this.conn?.write(j({
		"status": c.R_ERR_UNKNOWN,
		"login":  c.L_DEVICE,
		"url":    device.url
	    }))
	})

	/* 登录 */
	if (info.method === "0" && info.passwd)
	    this.client?.login(info.passwd)
	else if (info.method === "1")
	    this.client?.login()
    }

    async _initCb (info: i.INIT_INFO) {
	/* 如果 Client 已经初始化，销毁 */
	if (this.client)
	    await this.client.logout(false)
	/* 初始化新的 Client */
	this.client = createClient(Number(info.uin), {
	    data_dir: options['data-dir'], platform: Number(info.platform)
	})
	this.conn.write(c.R_OK_J)
    }

    async _usendCb (info: i.USEND_INFO) {
	const friendInfo = this.buildAltNameFriend(info.id)
	if (!friendInfo) {
	    this.conn.write(c.R_ERR_NON_EXIST_J)
	    return
	}
	
	this.client?.pickFriend(friendInfo.user_id)
	    .sendMsg(info.message).then(() => {
		this.conn.write(c.R_OK_J)
	    }).catch((e) => {
		console.log("发送消息出错：", e)
		this.conn.write(c.R_ERR_UNKNOWN_J)
	    })
    }

    async _usendImgCb (info: i.USEND_IMG_INFO) {
	const friendInfo = this.buildAltNameFriend(info.id)
	if (!friendInfo) {
	    this.conn.write(c.R_ERR_NON_EXIST_J)
	    return
	}
	
	this.client?.pickFriend(friendInfo.user_id)
	    .sendMsg(segment.image(Buffer.from(info.data, 'base64')))
	    .then(() => {
		this.conn.write(c.R_OK_J)
	    }).catch((e) => {
		console.log("发送消息出错：", e)
		this.conn.write(c.R_ERR_UNKNOWN_J)
	    })
    }

     async _gsendCb (info: i.GSEND_INFO) {
	this.client?.pickGroup(Number(info.id))
	    .sendMsg(info.message).then(() => {
		this.conn.write(c.R_OK_J)
	    }).catch((e) => {
		console.log("发送消息出错：", e)
		this.conn.write(c.R_ERR_UNKNOWN_J)
	    })
    }

    async _gsendImgCb (info: i.GSEND_INFO) {
	this.client?.pickGroup(Number(info.id))
	    .sendMsg(segment.image(Buffer.from(info.data, 'base64')))
	    .then(() => {
		this.conn.write(c.R_OK_J)
	    }).catch((e) => {
		console.log("发送消息出错：", e)
		this.conn.write(c.R_ERR_UNKNOWN_J)
	    })
    }


    async _usendShakeCb (info: i.USEND_SHAKE_INFO) {
	const friendInfo = this.buildAltNameFriend(info.id)
	if (!friendInfo) {
	    this.conn.write(c.R_ERR_NON_EXIST_J)
	    return
	}
	
	this.client?.pickFriend(friendInfo.user_id)
	    .sendMsg(segment.poke(0)).then(() => {
		this.conn.write(c.R_OK_J)
	    }).catch((e) => {
		console.log("发送消息出错：", e)
		this.conn.write(c.R_ERR_UNKNOWN_J)
	    })
    }

    async _ginfoCb (info: i.GINFO_INFO) {
	let groupInfo = this.client?.gl.get(Number(info.id))

	if (!groupInfo)
	    this.conn.write(c.R_ERR_NON_EXIST_J)

	const response = await axios.get(`https://qinfo.clt.qq.com/cgi-bin/qun_info/get_group_info_all?gc=${groupInfo?.group_id}&bkn=${this.client?.bkn}`,
					 { headers: { 'Cookie': this.client?.cookies[''] || "" } })
	
	this.conn.write(j({
	    "status": c.R_OK,
	    "name": groupInfo?.group_name,
	    "topic": response.data['gIntro'] || "",
	}))
    }

    async _gmlistCb (info: i.GMLIST_INFO) {
	let memberList = await this.client?.getGroupMemberList(Number(info.id))
	let friendList = this.client?.getFriendList()
	let nameList = [], adminList = [], owner, altName

	if (!memberList || !friendList) {
	    this.conn.write(c.R_ERR_NON_EXIST_J)
	    return
	}

	for (let member of memberList.values()) {
	    /* 缓存获取到的群员信息 */
	    if (!this.memberInfoCache.includes(member))
		this.memberInfoCache.push(member)
	    
	    if (friendList.has(member.user_id)) {
		let friendInfo = friendList.get(member.user_id)
		if (!friendInfo) {
		    this.conn.write(c.R_ERR_NON_EXIST_J)
		    return
		}
		altName = this.buildFriendAltName(friendInfo)
	    } else {
		altName = await this.buildChatMemberAltName(member.group_id, member)
	    }
	    
	    nameList.push(altName)
	    
	    switch (member.role) {
		case "owner":
		    owner = altName
		    break;
		case "admin":
		    adminList.push(altName)
	    }
	}

	this.conn.write(j({
	    "status": 0,
	    "list"  : nameList,
	    "owner" : owner,
	    "admin" : adminList,
	}))
    }

    async _flistCb (_: i.FLIST_INFO) {
	let nameList = [], friendList = this.client?.fl
	let idList: number[] = [];

	if (!friendList) {
	    this.conn.write(c.R_ERR_NON_EXIST_J)
	    return
	}

	for (let friend of friendList.values()) {
	    nameList.push(this.buildFriendAltName(friend))
	    idList.push(friend.user_id)
	}

	this.conn.write(j({
	    "status": 0,
	    "list"  : nameList,
	    "idlist": idList,
	}))
	    
    }

    async _glistCb (_: i.GLIST_INFO) {
	let idList = [], nameList = []
	let iter = this.client?.gl.values()

	if (!iter) {
	    this.conn.write(c.R_ERR_NON_EXIST_J)
	    return
	}

	for (let group of iter) {
	    nameList.push(group.group_name)
	    idList.push(group.group_id.toString())
	}

	this.conn.write(j({
	    "status"  : 0,
	    "namelist": nameList,
	    "idlist"  : idList,
	}))
    }

    async _whoamiCb (_: i.WHOAMI_INFO) {
	this.conn.write(j({
	    "status": 0,
	    "name"  : this.client?.nickname,
	}))
    }

    async _statusCb (info: i.STATUS_INFO) {
	switch (info.status) {
	    case "busy":
		this.client?.setOnlineStatus(50)
		this.conn.write(c.R_OK_J)
		return
	    case "online":
		this.client?.setOnlineStatus(11)
		this.conn.write(c.R_OK_J)
		return
	    case "invisible":
		this.client?.setOnlineStatus(41)
		this.conn.write(c.R_OK_J)
		return
	}
    }

    async _lookupCb (info: i.LOOKUP_INFO) {
	let checkId = verifyAltName(info.nickname)
	let realName = checkId ? stripRealName(info.nickname) : info.nickname

	/* 从昵称获取相关群员信息 */
	let related: MemberInfo[] = []
	for (const memberInfo of this.memberInfoCache) {
	    if (checkId && fixMemberName(memberInfo) === realName
		&& memberInfo.user_id.toString().endsWith(info.nickname.slice(-4)))
		related.push(memberInfo)
	    else if (!checkId && fixMemberName(memberInfo) === realName)
		related.push(memberInfo)
	}

	/* 通过 ID 继续搜索相关信息 */
	for (const id of related.map(v => v.user_id)) {
	    for (const memberInfo of this.memberInfoCache) {
		if (memberInfo.user_id === id)
		    related.push(memberInfo)
	    }
	}
	related = related.filter((x, i) => i === related.indexOf(x))
	
	let infoList: GroupInfo[] = []
	let groupList = this.client?.getGroupList()
	for (const gid of related.map(v => v.group_id)) {
	    let info = groupList?.get(gid)
	    if (!info) continue
	    infoList.push(info)
	}

	let related_id = related.map(v => v.user_id)
	related_id = related_id.filter((x, i) => i === related_id.indexOf(x))
	this.conn.write(j({
	    "relation": infoList.map(v => `${v.group_name}[${v.group_id}]`).join("、"),
	    "id": related_id.join("、")
	}))
    }

    
    handleData (data: any) {
	if (options.debug)
	    console.log("IN: ", data)

	this.lock.acquire("cmd", () => this.callTable[data.command].bind(this)(data))
	    .catch((e) => { console.log("命令调用失败：", e) })
    }

    _handle_err (err: Error) {
	console.log(err)
    }

    constructor (conn: net.Socket) {
	this.conn = conn
	conn.pipe(ndjson.parse())
	    .on('data', this.handleData.bind(this))
	conn.on('close', async () => {
	    if (this.client?.isOnline)
		await this.client?.logout(false)
	    this.client?.removeAllListeners()
	})
	conn.on('error', this._handle_err.bind(this))
    }
}

const server = net.createServer((sock) => { new AxonClient(sock) })
server.listen(options.port, options.host)
