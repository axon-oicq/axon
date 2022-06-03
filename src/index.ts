import * as c   from './constant'
import * as i   from './interface'
import * as net from 'net'

import * as ndjson from 'ndjson'

import axios from 'axios'
import commandLineArgs from 'command-line-args'
import commandLineUsage from 'command-line-usage'

import Queue from 'promise-queue'
import { Client, createClient, FriendInfo, GroupInviteEvent, GroupMessageEvent,
	 MemberDecreaseEvent, MemberIncreaseEvent, MemberInfo, PrivateMessageEvent,
         MessageElem, 
         segment,
         GroupRecallEvent} from 'oicq'

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
	    return `收到QQ视频版本不支持查看）`
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

class AxonClient {
    /* 帐号信息表与昵称重复表 */
    acctInfoTable: Array<MemberInfo | FriendInfo> = []
    nickDupTable:  string[]                       = []
 
    client: Client | null = null
    conn: net.Socket

    invitation: GroupInviteEvent | null = null

    queue = new Queue(1, Infinity)

    buffers: Buffer[] = []
    isReading: boolean = false
    bytes_read = 0
    bytes_need = 0
    bytes_digi = 0

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

    /* 从替代昵称获取 ID */
    idFromAltName(altName: string): number {
	for (let info of this.acctInfoTable) {
	    if ("card" in info) {
		if (info.card !== '') {
		    if (info.card == altName)
			return info.user_id
		    else if (info.user_id.toString().endsWith(altName.split('#').slice(-1)[0])
			&& stripRealName(altName) === info.card)
			return info.user_id
		}
	    }

	    if (info.nickname == altName)
		return info.user_id
	    else if (info.user_id.toString().endsWith(altName.split('#').slice(-1)[0])
		&& stripRealName(altName) === info.nickname)
		return info.user_id
	}

	return -1
    }
    /* 从 ID 获取替代昵称 */
    altNameFromId(id: string | number): string {
	for (let info of this.acctInfoTable) {
	    if (id == info.user_id)
		return this.altNameFromInfo(info)
	}
	return "未知用户"
    }
    /* 从信息获取替代昵称 */
    altNameFromInfo(info: MemberInfo | FriendInfo): string {
	if ("card" in info) {
	    if (info.card !== '') {
		if (this.nickDupTable.includes(info.card))
		    return info.card.concat('#')
			.concat(info.user_id.toString().slice(-4))
		else
		    return info.card
	    }
	}

	if (this.nickDupTable.includes(info.nickname))
	    return info.nickname.concat('#')
		.concat(info.user_id.toString().slice(-4))
	else
	    return info.nickname
    }

    async updateTable() {
	let iter = this.client?.gl.values()
	/* 初始化表（考虑到可能会多次调用） */
	this.nickDupTable =  []
	this.acctInfoTable = []

	let promises = []
	if (!iter) return
	for (let info of iter)
	    promises.push(this.client?.getGroupMemberList(info.group_id))
	/* 从群列表聊生成表 */
	const results = await Promise.all(promises)
	for (let r in results) {
	    const memberList = results[r]?.values()
	    if (!memberList) continue
	    const memberListArr = Array.from(memberList);
	    this.nickDupTable = this.nickDupTable
		.concat(resolveAcctList(memberListArr))
	    this.acctInfoTable = this.acctInfoTable
		.concat(Array.from(memberListArr))
	}

	/* 从好友列表补全表 */
	if (!this.client?.fl) return
	let friendList = this.client?.fl.values()
	this.acctInfoTable = this.acctInfoTable
	    .concat(Array.from(friendList))
	this.nickDupTable = this.nickDupTable
	    .concat(resolveAcctList(Array.from(friendList)))

	this.conn.write(c.R_OK_J);
    }

    async _ePrivateMessage(e: PrivateMessageEvent) {
	let text: string = ''

	e.message.forEach(msg => {   
	    if (msg.type === "poke") {
		this.conn.write(j({
		    "status": c.R_STAT_EVENT,
		    "type"  : c.E_FRIEND_ATTENTION,
		    "sender": this.altNameFromId(e.sender.user_id),
		    "time"  : e.time,
		})); return
	    }

	    if ((msg.type == "image" || msg.type == "flash") && msg.url) {
		this.conn.write(j({
		    "status": c.R_STAT_EVENT,
		    "type"  : c.E_FRIEND_IMG_MESSAGE,
		    "sender": this.altNameFromId(e.sender.user_id),
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
	    "sender": this.altNameFromId(e.sender.user_id),
	    "time"  : e.time,
	    "text"  : text,
	}))
    }

    async _eGroupMessage(e: GroupMessageEvent) {
	let text: string = '';

	e.message.forEach(msg => {
	    if ((msg.type == "image" || msg.type == "flash") && msg.url) {
		if (! msg.url) return

		this.conn.write(j({
		    "status": c.R_STAT_EVENT,
		    "type"  : c.E_GROUP_IMG_MESSAGE,
		    "sender": this.altNameFromId(e.sender.user_id),
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
	    "sender": this.altNameFromId(e.sender.user_id),
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
	    "sender": this.altNameFromId(e.user_id),
	}))
    }

    async _eGroupIncrease(e: MemberIncreaseEvent) {
	const memberList = await this.client?.getGroupMemberList(e.group_id, true)
	const member = memberList?.get(e.user_id)
	if (!member) return

	/* 将新成员加入到信息表 */
	this.acctInfoTable.push(member)

	this.conn.write(j({
	    "status": c.R_STAT_EVENT,
	    "type"  : c.E_GROUP_INCREASE,
	    "name"  : this.altNameFromInfo(member),
	    "id"    : e.group_id,
	}))
    }

    async _eGroupDecrease(e: MemberDecreaseEvent) {
	this.conn.write(j({
	    "status": c.R_STAT_EVENT,
	    "type"  : c.E_GROUP_INCREASE,
	    "name"  : this.altNameFromId(e.user_id),
	    "id"    : e.group_id,
	}))
    }

    async _eGroupRecall(e: GroupRecallEvent) {
	this.conn.write(j({
	    "status": c.R_STAT_EVENT,
	    "type"  : c.E_GROUP_RECALL,
	    "name": this.altNameFromId(e.user_id),
	    "id"    : e.group_id
	}))
    }

    bindEventCb() {
	this.client?.on('message.private',       (e) => this.queue.add(() =>
	    this._ePrivateMessage.bind(this)(e)))
	this.client?.on('message.group',         (e) => this.queue.add(() =>
	    this._eGroupMessage.bind(this)(e)))
	this.client?.on('request.group.invite',  (e) => this.queue.add(() =>
	    this._eGroupInvite.bind(this)(e)))
	this.client?.on('notice.group.increase', (e) => this.queue.add(() =>
	    this._eGroupIncrease.bind(this)(e)))
	this.client?.on('notice.group.decrease', (e) => this.queue.add(() =>
	    this._eGroupDecrease.bind(this)(e)))
	this.client?.on('notice.group.recall',   (e) => this.queue.add(() =>
	    this._eGroupRecall.bind(this)(e)))
    }

    async _goAheadCb (_: null) {
	this.client?.login()
    }
    
    async _loginCb (info: i.LOGIN_INFO) {
	/* 添加回调 */
	this.client?.on('system.online', async () => {
	    await this.updateTable()
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
	this.client?.pickFriend(this.idFromAltName(info.id))
	    .sendMsg(info.message).then(() => {
		this.conn.write(c.R_OK_J)
	    }).catch((e) => {
		console.log("发送消息出错：", e)
		this.conn.write(c.R_ERR_UNKNOWN_J)
	    })
    }

    async _usendImgCb (info: i.USEND_IMG_INFO) {
	this.client?.pickFriend(this.idFromAltName(info.id))
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
	this.client?.pickFriend(this.idFromAltName(info.id))
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
	let nameList = [], adminList = [], owner

	if (!memberList) {
	    this.conn.write(c.R_ERR_NON_EXIST_J)
	    return
	}

	for (let member of memberList.values()) {
	    const altName = this.altNameFromInfo(member)

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
	let nameList = [], friendList = this.client?.getFriendList()
	let idList: number[] = [];

	if (!friendList) {
	    this.conn.write(c.R_ERR_NON_EXIST_J)
	    return
	}

	for (let friend of friendList.values()) {
	    nameList.push(this.altNameFromInfo(friend))
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
	    idList.push(group.group_id)
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
	let results: (FriendInfo | MemberInfo)[] = [];

	for (let ii of this.acctInfoTable) {
	    if ("card" in ii) {
		if (ii.card !== '') {
		    if (ii.card == info.nickname)
			results.push(ii)
		    else if (ii.user_id.toString().endsWith(info.nickname.split('#').slice(-1)[0])
			&& stripRealName(info.nickname)  === ii.card)
			results.push(ii)

		    continue
		}
	    }

	    if (info.nickname == ii.nickname)
		results.push(ii)
	    else if (ii.user_id.toString().endsWith(info.nickname.split('#').slice(-1)[0])
		&& stripRealName(info.nickname) === ii.nickname)
		results.push(ii)
	}

	let joined_group: string[] = [];

	for (let ii of results)
	    if ("group_id" in ii) {
		const g = this.client?.gl.get(ii.group_id)
		if (!g) return
		joined_group.push(`${g.group_name}[${g.group_id}]`)
	    }

	try {
	    this.conn.write(j({
		"status": c.R_OK,
		"nickname": results[0].nickname,
		"id": results[0].user_id.toString(),
		"card": stripRealName(info.nickname) ,
		"relation": joined_group.join(', '),
		"sex": results[0].sex,
	    }))
	} catch (e) {
	    console.log(e)
	    this.conn.write(c.R_ERR_NON_EXIST_J);
	}
    }

    handleData (data: any) {
	if (options.debug)
	    console.log("IN: ", data)

	this.queue.add(() => this.callTable[data.command].bind(this)(data))
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
