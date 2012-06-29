var http = require('http');
var port = Math.floor(Math.random() * 5e4 + 1e4);

http.createServer(function (req, res) {
    res.end(JSON.stringify([ 'beepity', process.env ]));
}).listen(port, function() {
	console.log('port:' + port);
});
