/**
 * queue.js — 并发池 / PS 串行锁 / 任务表
 *
 * 为什么要分开：
 *   - 网络请求可以并发（快）
 *   - Photoshop 的文档操作不能并发，必须排队，否则会互相打架
 * 所以任务本身并发跑，但"贴回"这一步走 PS 锁串行执行。
 */

var U = require('./util.js');

/* ------------------------------------------------------------------ */
/*  并发池                                                             */
/* ------------------------------------------------------------------ */

function createPool(maxConcurrency) {
  var max = Math.max(1, maxConcurrency || 1);
  var running = 0;
  var queue = [];
  var drainedCbs = [];

  function pump() {
    while (running < max && queue.length > 0) {
      var job = queue.shift();
      if (job.cancelled) {
        job.reject(new Error('已取消'));
        continue;
      }
      running++;
      (function (j) {
        Promise.resolve()
          .then(j.fn)
          .then(
            function (r) {
              running--;
              j.resolve(r);
              pump();
              checkDrained();
            },
            function (e) {
              running--;
              j.reject(e);
              pump();
              checkDrained();
            }
          );
      })(job);
    }
    checkDrained();
  }

  function checkDrained() {
    if (running === 0 && queue.length === 0 && drainedCbs.length > 0) {
      var cbs = drainedCbs.slice();
      drainedCbs.length = 0;
      for (var i = 0; i < cbs.length; i++) {
        try {
          cbs[i]();
        } catch (e) {
          // 回调出错不影响队列
        }
      }
    }
  }

  return {
    setMax: function (n) {
      max = Math.max(1, n || 1);
      pump();
    },
    add: function (fn) {
      return new Promise(function (resolve, reject) {
        queue.push({ fn: fn, resolve: resolve, reject: reject, cancelled: false });
        pump();
      });
    },
    /** 清空还没开始的任务 */
    clear: function () {
      var n = queue.length;
      var pending = queue.slice();
      queue.length = 0;
      for (var i = 0; i < pending.length; i++) {
        pending[i].cancelled = true;
        try {
          pending[i].reject(new Error('已取消'));
        } catch (e) {
          // 忽略
        }
      }
      return n;
    },
    stats: function () {
      return { running: running, waiting: queue.length, max: max };
    },
    onDrained: function (cb) {
      drainedCbs.push(cb);
      checkDrained();
    }
  };
}

/* ------------------------------------------------------------------ */
/*  PS 串行锁                                                          */
/* ------------------------------------------------------------------ */

function createPSLock() {
  var chain = Promise.resolve();

  return {
    acquire: function (fn) {
      var result = chain.then(
        function () {
          return fn();
        },
        function () {
          return fn();
        }
      );
      // 让链条继续，不管这一步是成功还是失败
      chain = result.then(
        function () {
          return U.sleep(120);
        },
        function () {
          return U.sleep(120);
        }
      );
      return result;
    }
  };
}

/* ------------------------------------------------------------------ */
/*  任务表                                                             */
/* ------------------------------------------------------------------ */

function createTaskManager(onChange) {
  var tasks = [];

  function notify() {
    if (onChange) {
      try {
        onChange(tasks.slice());
      } catch (e) {
        // UI 回调出错不影响任务
      }
    }
  }

  return {
    list: function () {
      return tasks.slice();
    },
    /**
     * @param {string} prompt 提示词
     * @param {number} [index] 这是这条提示词的第几张
     * @param {number} [total] 这条提示词一共要生成几张
     */
    add: function (prompt, index, total) {
      var task = {
        id: U.uid('task'),
        prompt: prompt,
        index: index || 1,
        total: total || 1,
        state: 'queued',
        message: '',
        startedAt: 0,
        finishedAt: 0,
        controller: null
      };
      tasks.push(task);
      notify();
      return task;
    },
    update: function (id, patch) {
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].id === id) {
          for (var k in patch) {
            if (Object.prototype.hasOwnProperty.call(patch, k)) tasks[i][k] = patch[k];
          }
          break;
        }
      }
      notify();
    },
    /** 取消单个任务；返回 true 表示这个任务确实需要中断 */
    cancel: function (id) {
      for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].id !== id) continue;
        var t = tasks[i];
        if (t.state === 'queued' || t.state === 'running') {
          if (t.controller) {
            try {
              t.controller.abort();
            } catch (e) {
              // 忽略
            }
          }
          t.state = 'cancelled';
          t.finishedAt = Date.now();
          notify();
          return true;
        }
        return false;
      }
      return false;
    },
    /** 取消所有未完成任务，返回被中断的数量 */
    cancelAll: function () {
      var n = 0;
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        if (t.state === 'queued' || t.state === 'running') {
          if (t.controller) {
            try {
              t.controller.abort();
            } catch (e) {
              // 忽略
            }
          }
          t.state = 'cancelled';
          t.finishedAt = Date.now();
          n++;
        }
      }
      if (n > 0) notify();
      return n;
    },
    counts: function () {
      var c = { total: tasks.length, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
      for (var i = 0; i < tasks.length; i++) {
        var s = tasks[i].state;
        if (c[s] !== undefined) c[s]++;
      }
      return c;
    }
  };
}

module.exports = {
  createPool: createPool,
  createPSLock: createPSLock,
  createTaskManager: createTaskManager
};
