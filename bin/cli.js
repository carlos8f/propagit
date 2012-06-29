#!/usr/bin/env node
var argv = require('optimist').argv;
var propagit = require('../');
var spawn = require('child_process').spawn;
var path = require('path');

var cmd = argv._[0];

if (cmd === 'drone') {
    var drone = propagit(argv).drone();
    
    drone.on('error', function (err) {
        console.error(err && err.stack || err);
    });
    
    drone.on('spawn', function (opts) {
        console.log(
            '[' + opts.repo + '.' + opts.commit.slice(8) + '] '
            + opts.command.join(' ')
        );
    });
    
    drone.on('exit', function (code, sig, opts) {
        console.error([
            '[' + opts.repo + '.' + opts.commit.slice(8) + ']',
            opts.command.join(' '),
            'exited with code', code,
            'from', sig,
        ].join(' '));
    });
    
    drone.on('stdout', function (buf, opts) {
        console.log('['
            + opts.repo + '.' + opts.commit.slice(8)
        + '] ' + buf);
    });
    
    drone.on('stderr', function (buf, opts) {
        console.log('['
            + opts.repo + '.' + opts.commit.slice(8)
        + '] ' + buf);
    });
    
    drone.on('up', function (err) {
        console.log('connected to the hub');
    });
    
    drone.on('reconnect', function (err) {
        console.log('reconnecting to the hub');
    });
    
    drone.on('down', function (err) {
        console.log('disconnected from the hub');
    });
}
else if (cmd === 'hub') {
    var cport = argv.cport || argv.port;
    var gport = argv.gport || cport + 1;
    
    propagit(argv).listen(cport, gport);
    
    console.log('control service listening on :' + cport);
    console.log('git service listening on :' + gport);
}
else if (cmd === 'deploy') {
    var repo = argv._[1];
    var commit = argv._[2];
    
    var deploy = propagit(argv).deploy({
        repo : repo,
        commit : commit,
    });
    deploy.on('deploy', function () {
        deploy.hub.close();
    });
}
else if (cmd === 'spawn') {
    var repo = argv._[1];
    var commit = argv._[2];
    var command = argv._.slice(3);
    
    var s = propagit(argv).spawn({
        drone : argv.drone || '*',
        drones : argv.drones,
        repo : repo,
        commit : commit,
        command : command,
        limit : argv.limit,
        count : argv.count || 1,
        env : argv.env || {},
    });
    s.on('spawn', function () {
        s.hub.close();
    });
}
else if (cmd === 'ps') {
    var p = propagit(argv);
    var s = p.ps();
    
    if (argv.json) {
        var drones = {};
        s.on('data', function (name, proc) {
            drones[name] = proc;
        });
        s.on('end', function () {
            console.log(JSON.stringify(drones));
            p.hub.close();
        });
    }
    else {
        s.on('data', function (name, proc) {
            console.dir([ name, proc ]);
        });
        
        s.on('end', function () {
            p.hub.close();
        });
    }
}
else if (cmd === 'hosts') {
    var p = propagit(argv);
    var s = p.ps();
    
    var addrs = {};
    s.on('addr', function (name, addr) {
        addrs[addr] || (addrs[addr] = []);
        addrs[addr].push(name);
    });

    s.on('end', function () {
        if (argv.json) {
            console.log(JSON.stringify(addrs));
        }
        else {
            Object.keys(addrs).forEach(function(addr) {
                console.log(addr + "\t" + addrs[addr].join(' '));
            });
        }
        p.hub.close();
    });
}
else if (cmd === 'stop') {
    var s = propagit(argv).stop({
        drone : argv.drone || '*',
        drones : argv.drones,
        pid : argv.all ? '*' : argv._.slice(1).map(function (x) { return x.toString().replace(/^pid#/, '') }),
        commit : argv.commit,
    });
    s.on('stop', function(drones) {
        Object.keys(drones).forEach(function (id) {
            console.log('[' + id + '] stopped ' + drones[id].join(' '));
        });
        s.hub.close();
    });
}
else {
    console.log([
        'Usage:',
        '  propagit OPTIONS hub',
        '',
        '    Create a server to coordinate drones.',
        '',
        '    --port       port to listen on',
        '    --secret     password to use',
        '    --basedir    directory to put repositories',
        '',
        '  propagit OPTIONS drone',
        '',
        '    Listen to the hub for deploy events and execute COMMAND with',
        '    environment variables $REPO and $COMMIT on each deploy.',
        '',
        '    --hub        connect to the hub host:port',
        '    --secret     password to use',
        '    --basedir    directory to put repositories and deploys in',
        '',
        '  propagit OPTIONS deploy REPO COMMIT [COMMAND...]',
        '',
        '    Deploy COMMIT to all of the drones listening to the hub.',
        '',
        '    --hub        connect to the hub host:port',
        '    --secret     password to use',
        '',
        '  propagit OPTIONS spawn REPO COMMIT [COMMAND...]',
        '',
        '    Run COMMAND on all the drones specified by OPTIONS.',
        '    You can specify environment variables to run with'
            + ' --env.NAME=VALUE.',
        '',
        '    --count      how many to spawn per drone (default: 1)',
        '    --limit      max processes for commit per drone',
        '',
        '  propagit OPTIONS ps',
        '',
        '    List all the running processes on all the drones.',
        '',
        '    --json       output a JSON representation',
        '',
        '  propagit OPTIONS hosts',
        '',
        '    List drones grouped by IP address.',
        '',
        '    --json       output a JSON representation',
        '',
        '  propagit OPTIONS stop [--all | --commit=<hash> | PID PID...]',
        '',
        '    Stop spawned processes on all drones specified by OPTIONS.',
        '    If --drone is not specified, all drones will be selected.',
        '    A leading "pid#" will be stripped from PIDs.',
        '',
        '    --all        stop all processes on each selected drone',
        '    --commit     stop processes by commit hash on each',
        '                 selected drone',
        '',
    ].join('\n'));
}

function parseAddr (addr) {
    var s = addr.toString().split(':');
    return {
        host : s[1] ? s[0] : 'localhost',
        port : parseInt(s[1] || s[0], 10),
    };
}
