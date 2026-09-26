(function (root) {
    "use strict";

    /**
     * 返回当前加载项根目录。WPS 的 ribbon 回调在根入口页中执行，
     * 因此任务窗格 URL 可以稳定地拼接为 `${GetUrlPath()}/ui/taskpane.html`。
     */
    function getUrlPath() {
        if (root.location && root.location.href) {
            try {
                return new URL(".", root.location.href).href.replace(/\/$/, "");
            } catch (error) {
                // 老版本内核可能没有完整的 URL 实现，继续使用字符串回退。
            }
        }

        if (root.location && root.location.pathname) {
            return root.location.pathname.replace(/\/index\.html?$/, "");
        }

        return "";
    }

    root.GetUrlPath = getUrlPath;
})(typeof window !== "undefined" ? window : globalThis);
