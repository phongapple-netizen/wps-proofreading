(function (root) {
    "use strict";

    function getApplication() {
        // 新版 WPS 通常暴露 window.Application。
        if (root.Application && typeof root.Application === "object") {
            return root.Application;
        }

        var wpsRoot = root.wps;
        if (!wpsRoot) {
            return null;
        }

        // 部分版本通过 WpsApplication() 返回 Application 对象。
        if (typeof wpsRoot.WpsApplication === "function") {
            try {
                return wpsRoot.WpsApplication();
            } catch (error) {
                // 继续尝试其它兼容入口。
            }
        }

        if (wpsRoot.Application && typeof wpsRoot.Application === "object") {
            return wpsRoot.Application;
        }

        // 旧版 wps 对象本身就包含 Selection/CreateTaskPane 等成员。
        return wpsRoot;
    }

    function getSelection() {
        var application = getApplication();
        if (!application) {
            return null;
        }

        try {
            if (application.Selection) {
                return application.Selection;
            }

            if (application.ActiveDocument && application.ActiveDocument.Application) {
                return application.ActiveDocument.Application.Selection || null;
            }
        } catch (error) {
            return null;
        }

        return null;
    }

    function readSelectionText() {
        var selection = getSelection();
        if (!selection) {
            return "";
        }

        try {
            return typeof selection.Text === "string" ? selection.Text : String(selection.Text || "");
        } catch (error) {
            return "";
        }
    }

    function replaceSelectionText(text) {
        var selection = getSelection();
        if (!selection) {
            return false;
        }

        var replacement = String(text == null ? "" : text);
        try {
            // 文字加载项的 Selection.Range 是最小的可替换范围。
            if (selection.Range) {
                selection.Range.Text = replacement;
                return true;
            }

            // 兼容少数版本直接在 Selection.Text 上提供写入能力。
            selection.Text = replacement;
            return true;
        } catch (error) {
            return false;
        }
    }

    function getTaskPane(taskPaneId) {
        var application = getApplication();
        if (!application || !taskPaneId || typeof application.GetTaskPane !== "function") {
            return null;
        }

        try {
            return application.GetTaskPane(taskPaneId) || null;
        } catch (error) {
            return null;
        }
    }

    function createTaskPane(url) {
        var application = getApplication();
        if (!application || typeof application.CreateTaskPane !== "function") {
            return null;
        }

        try {
            return application.CreateTaskPane(url) || null;
        } catch (error) {
            return null;
        }
    }

    function getPluginStorage() {
        var application = getApplication();
        return application && application.PluginStorage ? application.PluginStorage : null;
    }

    root.WpsNativeDocument = {
        getApplication: getApplication,
        getSelection: getSelection,
        readSelectionText: readSelectionText,
        replaceSelectionText: replaceSelectionText,
        getTaskPane: getTaskPane,
        createTaskPane: createTaskPane,
        getPluginStorage: getPluginStorage
    };
})(typeof window !== "undefined" ? window : globalThis);
