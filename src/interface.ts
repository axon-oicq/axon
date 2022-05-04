/* 初始化 OICQ 客户端 */
export interface INIT_INFO {
    /* 客户端对应的 QQ 号 */
    uin : string;
    /* 1:安卓手机 2:aPad 3:安卓手表 4:MacOS 5:iPad */
    platform : "1" | "2" | "3" | "4" | "5";
}

/* 登录 */
export interface LOGIN_INFO {
    /* 0:密码登录 1:扫码登录 */
    method: "0" | "1"
    /* 明文密码或 MD5 */
    passwd?: string
}

/* 输出 OICQ 客户端中的所有好友 */
export interface UDUMP_INFO {
    // ...
}

/* 输出 OICQ 客户端中的所有群 ID */
export interface GDUMP_INFO {
    // ...
}

/* 向一个好友发送消息 */
export interface USEND_INFO {
    /* 发送的对象（替代昵称） */
    id: string
    /* 文本消息 */
    message: string
}

/* 向一个好友发送图片消息 */
export interface USEND_IMG_INFO {
    /* 发送的对象（替代昵称） */
    id: string
    /* 文本消息 */
    data: string
}

/* 向一个群聊发送消息 */
export interface GSEND_INFO {
    /* 发送的对象（QQ群） */
    id: string
    /* 文本消息 */
    message: string
}

/* 向一个群聊发送图片 */
export interface GSEND_INFO {
    /* 发送的对象（QQ群） */
    id: string
    /* 文本消息 */
    data: string
}

/* 向好友发送窗口抖动 */
export interface USEND_SHAKE_INFO {
    /* 发送的对象（替代昵称） */
    id: string
}

/* 查询群聊信息 */
export interface GINFO_INFO {
    /* 查询的对象（QQ群） */
    id: string
}

/* 查询群聊成员信息 */
export interface GMLIST_INFO {
    /* 查询的对象（QQ群） */
    id: string
}

/* 获取好友列表 */
export interface FLIST_INFO {
    // ...
}

/* 获取群聊列表 */
export interface GLIST_INFO {
    // ...
}

/* 获取我的昵称 */
export interface WHOAMI_INFO {
    // ...
}

/* 根据昵称查询用户信息 */
export interface LOOKUP_INFO {
    /* 替代昵称 */
    nickname: string
}

/* 接收一个邀请 */
export interface APPROVE_INFO {
    // ...
}

/* 拒绝一个邀请 */
export interface REFUSE_INFO {
    // ...
}

/* 修改在线状态 */
export interface STATUS_INFO {
    /* 目标状态 */
    status: "busy" | "online" | "invisible"
}
