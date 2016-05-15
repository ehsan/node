'use strict';

var _lazyConstants = null;

function lazyConstants() {
  if (!_lazyConstants) {
    _lazyConstants = process.binding('constants');
  }
  return _lazyConstants;
}

exports.setup_cpuUsage = setup_cpuUsage;
exports.setup_hrtime = setup_hrtime;
exports.setupConfig = setupConfig;
exports.setupKillAndExit = setupKillAndExit;
exports.setupSignalHandlers = setupSignalHandlers;
exports.setupChannel = setupChannel;
exports.setupRawDebug = setupRawDebug;


const assert = process.assert = function(x, msg) {
  if (!x) throw new Error(msg || 'assertion error');
};


// Set up the process.cpuUsage() function.
function setup_cpuUsage() {
  // Get the native function, which will be replaced with a JS version.
  const _cpuUsage = process.cpuUsage;

  // Create the argument array that will be passed to the native function.
  const cpuValues = new Float64Array(2);

  // Replace the native function with the JS version that calls the native
  // function.
  process.cpuUsage = function cpuUsage(prevValue) {
    // If a previous value was passed in, ensure it has the correct shape.
    if (prevValue) {
      if (!previousValueIsValid(prevValue.user)) {
        throw new TypeError('value of user property of argument is invalid');
      }

      if (!previousValueIsValid(prevValue.system)) {
        throw new TypeError('value of system property of argument is invalid');
      }
    }

    // Call the native function to get the current values.
    const errmsg = _cpuUsage(cpuValues);
    if (errmsg) {
      throw new Error('unable to obtain CPU usage: ' + errmsg);
    }

    // If a previous value was passed in, return diff of current from previous.
    if (prevValue) return {
      user: cpuValues[0] - prevValue.user,
      system: cpuValues[1] - prevValue.system
    };

    // If no previous value passed in, return current value.
    return {
      user: cpuValues[0],
      system: cpuValues[1]
    };

    // Ensure that a previously passed in value is valid. Currently, the native
    // implementation always returns numbers <= Number.MAX_SAFE_INTEGER.
    function previousValueIsValid(num) {
      return Number.isFinite(num) &&
          num <= Number.MAX_SAFE_INTEGER &&
          num >= 0;
    }
  };
}


function setup_hrtime() {
  const _hrtime = process.hrtime;
  const hrValues = new Uint32Array(3);

  process.hrtime = function hrtime(ar) {
    _hrtime(hrValues);

    if (typeof ar !== 'undefined') {
      if (Array.isArray(ar)) {
        const sec = (hrValues[0] * 0x100000000 + hrValues[1]) - ar[0];
        const nsec = hrValues[2] - ar[1];
        return [nsec < 0 ? sec - 1 : sec, nsec < 0 ? nsec + 1e9 : nsec];
      }

      throw new TypeError('process.hrtime() only accepts an Array tuple');
    }

    return [
      hrValues[0] * 0x100000000 + hrValues[1],
      hrValues[2]
    ];
  };
}


function setupConfig(_source) {
  // NativeModule._source
  // used for `process.config`, but not a real module
  var config = _source.config;
  delete _source.config;

  // strip the gyp comment line at the beginning
  config = config.split('\n')
      .slice(1)
      .join('\n')
      .replace(/"/g, '\\"')
      .replace(/'/g, '"');

  process.config = JSON.parse(config, function(key, value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  });
  const processConfig = process.binding('config');
  // Intl.v8BreakIterator() would crash w/ fatal error, so throw instead.
  if (processConfig.hasIntl &&
      processConfig.hasSmallICU &&
      Intl.hasOwnProperty('v8BreakIterator') &&
      !process.icu_data_dir) {
    const des = Object.getOwnPropertyDescriptor(Intl, 'v8BreakIterator');
    des.value = function v8BreakIterator() {
      throw new Error('v8BreakIterator: full ICU data not installed. ' +
                      'See https://github.com/nodejs/node/wiki/Intl');
    };
    Object.defineProperty(Intl, 'v8BreakIterator', des);
  }
  // Don’t let icu_data_dir leak through.
  delete process.icu_data_dir;
}


function setupKillAndExit() {

  process.exit = function(code) {
    if (code || code === 0)
      process.exitCode = code;

    if (!process._exiting) {
      process._exiting = true;
      process.emit('exit', process.exitCode || 0);
    }

    // Flush stdio streams prior to exit.
    // `flushSync` not present if stream redirected to file in shell.
    flushSync(process.stdout);
    flushSync(process.stderr);

    process.reallyExit(process.exitCode || 0);

    function flushSync(stream) {

      // FIXME: Behavior of this function outside of process.exit() is
      // undefined due to the following factors:
      // * Stream fd may be blocking after this call.
      // * In the event of an incomplete flush pending buffered write
      //   requests may be truncated.
      // * No return code.

      if (stream._writev)
        return;

      var handle = stream._handle;
      if (!handle || !handle.flushSync)
        return;

      var fd = handle.fd;
      if (typeof fd !== 'number' || fd < 0)
        return;

      // FIXME: late module resolution avoids cross require problem
      const fs = require('fs');

      // Queued libuv writes must be flushed first.
      // Note: fd will set to blocking after handle.flushSync()
      if (handle.flushSync() !== 0) {
        // bad fd or write queue for libuv stream not entirely flushed
        return;
      }

      // then the queued stream chunks can be flushed
      var state = stream._writableState;
      var entry = state.bufferedRequest;
      while (entry) {
        var chunk = entry.chunk;
        if (!(chunk instanceof Buffer)) {
          chunk = Buffer.from(chunk, entry.encoding);
        }
        // Note: fd is blocking at this point
        var written = fs.writeSync(fd, chunk, 0, chunk.length);
        if (written !== chunk.length) {
          // stream chunk not flushed entirely - stop writing.
          // FIXME: buffered request queue should be repaired here
          //        rather than being truncated after loop break
          break;
        }
        entry = entry.next;
      }

      state.bufferedRequestCount = 0;
      state.bufferedRequest = null;
      state.lastBufferedRequest = null;
    }
  };

  process.kill = function(pid, sig) {
    var err;

    if (pid != (pid | 0)) {
      throw new TypeError('invalid pid');
    }

    // preserve null signal
    if (0 === sig) {
      err = process._kill(pid, 0);
    } else {
      sig = sig || 'SIGTERM';
      if (lazyConstants()[sig] &&
          sig.slice(0, 3) === 'SIG') {
        err = process._kill(pid, lazyConstants()[sig]);
      } else {
        throw new Error(`Unknown signal: ${sig}`);
      }
    }

    if (err) {
      var errnoException = require('util')._errnoException;
      throw errnoException(err, 'kill');
    }

    return true;
  };
}


function setupSignalHandlers() {
  // Load events module in order to access prototype elements on process like
  // process.addListener.
  var signalWraps = {};

  function isSignal(event) {
    return typeof event === 'string' &&
           event.slice(0, 3) === 'SIG' &&
           lazyConstants().hasOwnProperty(event);
  }

  // Detect presence of a listener for the special signal types
  process.on('newListener', function(type, listener) {
    if (isSignal(type) &&
        !signalWraps.hasOwnProperty(type)) {
      var Signal = process.binding('signal_wrap').Signal;
      var wrap = new Signal();

      wrap.unref();

      wrap.onsignal = function() { process.emit(type); };

      var signum = lazyConstants()[type];
      var err = wrap.start(signum);
      if (err) {
        wrap.close();
        var errnoException = require('util')._errnoException;
        throw errnoException(err, 'uv_signal_start');
      }

      signalWraps[type] = wrap;
    }
  });

  process.on('removeListener', function(type, listener) {
    if (signalWraps.hasOwnProperty(type) && this.listenerCount(type) === 0) {
      signalWraps[type].close();
      delete signalWraps[type];
    }
  });
}


function setupChannel() {
  // If we were spawned with env NODE_CHANNEL_FD then load that up and
  // start parsing data from that stream.
  if (process.env.NODE_CHANNEL_FD) {
    var fd = parseInt(process.env.NODE_CHANNEL_FD, 10);
    assert(fd >= 0);

    // Make sure it's not accidentally inherited by child processes.
    delete process.env.NODE_CHANNEL_FD;

    var cp = require('child_process');

    // Load tcp_wrap to avoid situation where we might immediately receive
    // a message.
    // FIXME is this really necessary?
    process.binding('tcp_wrap');

    cp._forkChild(fd);
    assert(process.send);
  }
}


function setupRawDebug() {
  var format = require('util').format;
  var rawDebug = process._rawDebug;
  process._rawDebug = function() {
    rawDebug(format.apply(null, arguments));
  };
}
