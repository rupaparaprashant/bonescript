// Copyright (C) 2011 - Texas Instruments, Jason Kridner
//
//
var fs = require('fs');
var child_process = require('child_process');
var http = require('http');
var url = require('url');
var winston = require('winston');
var socketio = require('socket.io');
var express = require('express');

myrequire('systemd', function() {
    winston.debug("Startup as socket-activated service under systemd not enabled");
});

var port = (process.env.LISTEN_PID > 0) ? 'systemd' : ((process.env.PORT) ? process.env.PORT : 80);
var directory = (process.env.SERVER_DIR) ? process.env.SERVER_DIR : '/var/lib/cloud9';
listen(port, directory);

function listen(port, directory) {
    winston.info("Opening port " + port + " to serve up " + directory);
    var app = express();
    app.use(express.logger());
    app.get('/bonescript.js', handler);
    app.use(express.static(directory));
    var server = http.createServer(app);
    addSocketListeners(server);
    server.listen(port);
}

function handler(req, res) {
    function sendFile(err, file) {
        if(err) {
            res.writeHead(500, {"Content-Type": "text/plain"});
            res.end(err + '\n');
            return;
        }
        res.setHeader('Content-Type', 'text/javascript');
        file = file.replace(/___INSERT_HOST___/g, host);
        res.end(file);
    }
    var parsedUrl = url.parse(req.url);
    var uri = parsedUrl.pathname;
    var host = 'http://' + req.headers.host;
    if(uri == '/bonescript.js') {
        fs.readFile('src/bonescript.js', 'utf8', sendFile);
    }
}

function addSocketListeners(server) {
    var io = socketio.listen(server);
    io.set('log level', 0);
    io.set('heartbeats', true);
    io.set('polling duration', 1);
    io.set('heartbeat interval', 2);
    io.set('heartbeat timeout', 10);
    winston.debug('Listening for new socket.io clients');
    io.sockets.on('connection', onconnect);
    function onconnect(socket) {
        winston.debug('Client connected');

        // on disconnect
        socket.on('disconnect', function() {
            winston.debug('Client disconnected');
        });

        spawn(socket);

        var modmsg = {};
        modmsg.module = 'bonescript';
        modmsg.data = {};

        var callMyFunc = function(name, m) {
            var myCallback = function(resp) {
                winston.debug(name + ' replied to ' + JSON.stringify(m) + ' with ' + JSON.stringify(resp));
                if(typeof m.seq == 'undefined') return;
                if(!resp || (typeof resp != 'object')) resp = {'data': resp};
                resp.seq = m.seq;
                // TODO: consider setting 'oneshot'
                winston.debug('Sending message "bonescript": ' + JSON.stringify(resp));
                socket.emit('bonescript', resp);
            };
            try {
                var callargs = [];
                for(var arg in b[name].args) {
                    var argname = b[name].args[arg];
                    if(argname == 'callback') {
                        if(typeof m.seq == 'number') callargs.push(myCallback);
                        else callargs.push(null);
                    } else if(typeof m[argname] != 'undefined') {
                        callargs.push(m[argname]);
                    } else {
                        callargs.push(undefined);
                    }
                }
                winston.debug('Calling ' + name + '(' + callargs.join(',') + ')');
                b[name].apply(this, callargs);
            } catch(ex) {
                winston.debug('Error handing ' + name + ' message: ' + ex);
                winston.debug('m = ' + JSON.stringify(m));
            }
        };

        var addSocketX = function(message, name) {
            var onFuncMessage = function(m) {
                callMyFunc(name, m);
            };
            socket.on(message, onFuncMessage);
        };

        var b = require('./index');
        for(var i in b) {
            if(typeof b[i] == 'function') {
                if(typeof b[i].args != 'undefined') {
                    modmsg.data[i] = {};
                    modmsg.data[i].name = i;
                    modmsg.data[i].type = 'function';
                    modmsg.data[i].value = b[i].args;
                    addSocketX('bonescript$' + i, i);
                }
            } else {
                modmsg.data[i] = {};
                modmsg.data[i].name = i;
                modmsg.data[i].type = typeof b[i];
                modmsg.data[i].value = b[i];
            }
        }

        socket.emit('require', modmsg);
    }
}

function myrequire(packageName, onfail) {
    var y = {};
    try {
        y = require(packageName);
        y.exists = true;
    } catch(ex) {
        y.exists = false;
        winston.debug("Optional package '" + packageName + "' not loaded");
        if(onfail) onfail();
    }
    return(y);
}

// most heavily borrowed from https://github.com/itchyny/browsershell
function spawn(socket) {
    var stream = '';
    var timer;
    var len = 0;
    var c;

    socket.on('shell', receive);
    return(receive);

    function receive(msg) {
        if(!c) {
            try {
                winston.debug('Spawning bash');
                c = child_process.spawn('/bin/bash', ['-i'], {customFds: [-1, -1, -1]});
                c.stdout.on('data', send);
                c.stderr.on('data', send);
                c.on('exit', function() {
                    socket.emit('shell', send('\nexited\n'));
                    c = undefined;
                });
                socket.on('disconnect', function () {
                    winston.debug('Killing bash');
                    c.kill('SIGHUP');
                });
            } catch(ex) {
                c = undefined;
                send('Error invoking bash');
                winston.error('Error invoking bash');
            }
        }
        if(c) {
            if(msg) {
                c.stdin.write(msg + '\n', 'utf-8');
            }
        } else {
            winston.error('Unable to invoke child process');
        }
    }

    function send(data) {
       // add data to the stream
       stream += data.toString();
       ++len;

       // clear any existing timeout if it exists
       if(timer) clearTimeout(timer);

       // set new timeout
       timer = setTimeout(function () {
           socket.emit('shell', stream);
           stream = '';
           len = 0;
       }, 100);

       // send data if over threshold
       if(len > 1000)
       {
           clearTimeout(timer);
           socket.emit('shell', stream);
           stream = '';
           len = 0;
       }
    }
}
