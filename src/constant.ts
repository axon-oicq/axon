import * as path from "path"

/* Socket 服务端监听设置 */
export const HOST = '127.0.0.1'
export const PORT = 9999

/* OICQ 数据目录设置 */
export let data_dir: string;
if ("pkg" in process) {
  data_dir = path.resolve(process.execPath + '/..');
} else {
    data_dir = path.join(require.main
	? require.main.path
	: process.cwd())
}

/* Axon 版本信息 */
export const MOTD = {
    backend: "Axon",
    version: "1.0.1",
    status: 0,
}

/* 函数别名，JSON 转换 */
const j = (some: object) => {
    // console.log(some)
    return JSON.stringify(some)
}

/* 返回状态类型 */ 
export const R_OK_J            = j({ "status": 0  })
export const R_ERR_UNKNOWN_J   = j({ "status": -2 })
export const R_ERR_NO_CLIENT_J = j({ "status": -1 })
export const R_ERR_NON_EXIST_J = j({ "status": -3 })
export const R_STAT_EVENT_J    = j({ "status": 1  })

export const R_OK            =  0
export const R_ERR_UNKNOWN   = -2
export const R_ERR_NO_CLIENT = -1
export const R_ERR_NON_EXIST = -3
export const R_STAT_EVENT    =  1

/* 事件回调类型 */
export const E_FRIEND_MESSAGE     = 1
export const E_GROUP_MESSAGE      = 2
export const E_FRIEND_ATTENTION   = 3
export const E_GROUP_INVITE       = 4
export const E_GROUP_INCREASE     = 5
export const E_GROUP_DECREASE     = 6
export const E_GROUP_IMG_MESSAGE  = 7
export const E_FRIEND_IMG_MESSAGE = 8
export const E_GROUP_RECALL       = 9

/* 登录错误类型 */
export const L_DEVICE = 0
export const L_ERROR  = 1
export const L_SLIDER = 2
export const L_QRCODE = 3

