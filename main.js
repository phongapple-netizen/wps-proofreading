/*
 * WPS 的隐藏入口页加载此脚本。功能区回调必须在全局作用域可见，
 * 因此这里按官方无框架模板的方式使用 document.write 载入脚本。
 */
document.write("<script type='text/javascript' src='./js/util.js'><\/script>");
document.write("<script type='text/javascript' src='./js/wps-api.js'><\/script>");
document.write("<script type='text/javascript' src='./js/ribbon.js'><\/script>");
