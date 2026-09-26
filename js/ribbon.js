(function (root) {
    "use strict";

    var TASK_PANE_STORAGE_KEY = "wps_proofreading_taskpane_id";
    var TASK_PANE_PATH = "/ui/taskpane.html";
    var taskPaneIdCache = "";

    function documentApi() {
        return root.WpsNativeDocument || null;
    }

    function getControlId(control) {
        if (!control) {
            return "";
        }

        return control.Id || control.id || "";
    }

    function storageGet(key) {
        var api = documentApi();
        var storage = api && api.getPluginStorage ? api.getPluginStorage() : null;
        if (!storage || typeof storage.getItem !== "function") {
            return "";
        }

        try {
            return storage.getItem(key) || "";
        } catch (error) {
            return "";
        }
    }

    function storageSet(key, value) {
        var api = documentApi();
        var storage = api && api.getPluginStorage ? api.getPluginStorage() : null;
        if (!storage || typeof storage.setItem !== "function") {
            return false;
        }

        try {
            storage.setItem(key, value);
            return true;
        } catch (error) {
            return false;
        }
    }

    function joinUrl(base, path) {
        return String(base || "").replace(/\/$/, "") + path;
    }

    function setTaskPaneVisible(taskPane, visible) {
        if (!taskPane) {
            return false;
        }

        try {
            var application = documentApi().getApplication();
            var rightDock = application && application.Enum
                ? application.Enum.msoCTPDockPositionRight
                : 2;
            if (typeof rightDock === "number") {
                taskPane.DockPosition = rightDock;
            }
        } catch (error) {
            // 停靠位置不是所有版本都支持；窗格本身仍可继续使用。
        }

        try {
            taskPane.Visible = visible;
            return true;
        } catch (error) {
            return false;
        }
    }

    function isProofreadingControl(control) {
        return getControlId(control) === "wpsProofreadingOpenPanel";
    }

    function openProofreadingTaskPane() {
        var api = documentApi();
        if (!api || typeof api.createTaskPane !== "function") {
            return false;
        }

        var taskPaneId = storageGet(TASK_PANE_STORAGE_KEY) || taskPaneIdCache;
        var taskPane = taskPaneId && typeof api.getTaskPane === "function"
            ? api.getTaskPane(taskPaneId)
            : null;

        if (!taskPane) {
            taskPane = api.createTaskPane(joinUrl(root.GetUrlPath ? root.GetUrlPath() : "", TASK_PANE_PATH));
            if (!taskPane) {
                return false;
            }

            taskPaneId = taskPane.ID || taskPane.Id || "";
            if (taskPaneId) {
                taskPaneIdCache = taskPaneId;
                storageSet(TASK_PANE_STORAGE_KEY, taskPaneId);
            }

            return setTaskPaneVisible(taskPane, true);
        }

        taskPaneIdCache = taskPaneId;
        var visible = true;
        try {
            visible = !taskPane.Visible;
        } catch (error) {
            // 如果读取失败，按“打开”处理。
        }

        return setTaskPaneVisible(taskPane, visible);
    }

    function OnAddinLoad(ribbonUI) {
        var api = documentApi();
        if (api && api.getApplication) {
            var application = api.getApplication();
            if (application && typeof application === "object") {
                try {
                    if (!application.ribbonUI) {
                        application.ribbonUI = ribbonUI;
                    }
                } catch (error) {
                    // 某些版本的 ribbonUI 属性是只读的。
                }
            }
        }

        return true;
    }

    function OnAction(control) {
        if (isProofreadingControl(control)) {
            openProofreadingTaskPane();
        }

        return true;
    }

    function OnGetEnabled(control) {
        return isProofreadingControl(control);
    }

    function OnGetVisible() {
        return true;
    }

    // 保留官方 CustomUI 回调接口，暂不依赖图片资源，避免安装阶段出现资源路径错误。
    function GetImage() {
        return "";
    }

    root.OnAddinLoad = OnAddinLoad;
    root.OnAction = OnAction;
    root.OnGetEnabled = OnGetEnabled;
    root.OnGetVisible = OnGetVisible;
    root.GetImage = GetImage;
    root.openProofreadingTaskPane = openProofreadingTaskPane;
})(typeof window !== "undefined" ? window : globalThis);
