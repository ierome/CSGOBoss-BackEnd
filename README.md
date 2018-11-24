# sknejs

CS:GO Bot Manager

## Features

 - Support for multiple bots
 - Trade notifications
 - Send trade offers
 - Access bot inventory
 - Prices from SteamAnalyst

## Requirements

  - NodeJS
  - RabbitMQ
  - RethinkDB
  - SteamAnalyst and Steamlytics access

# Setup

## Setup Project

```
git clone git@bitbucket.org:csgoplay/sknejs.git
npm install
```

## Configuration

Based on your enviroment, create a file in ``config/production.json`` or ``config/development/json``

Example Configuration:

```
{
  "storageWhitelist": ["STEAMID64"],

  "bitskins": {
    "apiKey": "BITSKINS API KEY",
    "secret": "BITSKINS API SECRET"
  },

  "prices": {
    "steamanalyst": "STEAMANALYST URL",
    "steamlytics": "STEAMLYTICS API KEY",
    "markup": 1
  },

  "servers": {
    "localhost": "http://127.0.0.1:5355"
  },

  "bots": {
    "deposit1": {
      "display": "Deposit Bot 1",
      "username": "BOT USER NAME",
      "password": "BOT PASSWORD",
      "apiKey": "BOT API KEY",
      "sharedSecret": "BOT SHARED SECRET",
      "identitySecret": "BOT IDENTITY SECRET",
      "groups": ["deposit"],
      "acceptIncomingTrades": false
    }
  }
}
```

### Prices

Currently we get the prices from SteamAnalyst and use Steamlytics to get more information on items that Steamanalyst doesn't provide.

You can update the prices by running:

`node src/prices.js``

### Build

In production it is recommended to use the built version of the server, you can create this by running:

``npm run build``


## Scripts

 - **npm run readme** : `node ./node_modules/.bin/node-readme`
 - **npm run test** : `./node_modules/.bin/babel-tape-runner ./spec/**/*.spec.js | ./node_modules/.bin/tap-spec`
 - **npm run zuul** : `./node_modules/.bin/zuul --local --open -- spec/**/*.spec.js`
 - **npm run build** : `npm run test && npm run readme && ./node_modules/.bin/babel -d ./dist ./src`
 - **npm run publish** : `git push && git push --tags && npm publish`
 - **npm run start** : `babel-watch src/index.js`
 - **npm run start:admin** : `babel-watch src/admin/server/index.js`

## Dependencies

Package | Version | Dev
--- |:---:|:---:
[@opskins/api](https://www.npmjs.com/package/@opskins/api) | ^1.4.0 | ✖
[amqplib](https://www.npmjs.com/package/amqplib) | ^0.5.1 | ✖
[async](https://www.npmjs.com/package/async) | ^2.1.4 | ✖
[babel-polyfill](https://www.npmjs.com/package/babel-polyfill) | ^6.20.0 | ✖
[bluebird](https://www.npmjs.com/package/bluebird) | ^3.4.7 | ✖
[body-parser](https://www.npmjs.com/package/body-parser) | ^1.17.1 | ✖
[co](https://www.npmjs.com/package/co) | ^4.6.0 | ✖
[config](https://www.npmjs.com/package/config) | ^1.24.0 | ✖
[express](https://www.npmjs.com/package/express) | ^4.15.2 | ✖
[globaloffensive](https://www.npmjs.com/package/globaloffensive) | ^1.3.1 | ✖
[jayson](https://www.npmjs.com/package/jayson) | ^2.0.3 | ✖
[minimist](https://www.npmjs.com/package/minimist) | ^1.2.0 | ✖
[node-json-rpc](https://www.npmjs.com/package/node-json-rpc) | 0.0.1 | ✖
[node-schedule](https://www.npmjs.com/package/node-schedule) | ^1.2.0 | ✖
[notp](https://www.npmjs.com/package/notp) | ^2.0.3 | ✖
[numeral](https://www.npmjs.com/package/numeral) | ^2.0.4 | ✖
[randomstring](https://www.npmjs.com/package/randomstring) | ^1.1.5 | ✖
[redis](https://www.npmjs.com/package/redis) | ^2.6.5 | ✖
[request](https://www.npmjs.com/package/request) | ^2.81.0 | ✖
[request-ip](https://www.npmjs.com/package/request-ip) | ^2.0.1 | ✖
[rethinkdb](https://www.npmjs.com/package/rethinkdb) | ^2.3.3 | ✖
[rethinkdbdash](https://www.npmjs.com/package/rethinkdbdash) | ^2.3.29 | ✖
[steam](https://www.npmjs.com/package/steam) | ^1.4.0 | ✖
[steam-totp](https://www.npmjs.com/package/steam-totp) | ^1.4.0 | ✖
[steam-tradeoffer-manager](https://www.npmjs.com/package/steam-tradeoffer-manager) | ^2.7.0 | ✖
[steam-user](https://www.npmjs.com/package/steam-user) | ^3.21.7 | ✖
[steamcommunity](https://www.npmjs.com/package/steamcommunity) | ^3.30.7 | ✖
[steamid](https://www.npmjs.com/package/steamid) | ^1.1.0 | ✖
[thirty-two](https://www.npmjs.com/package/thirty-two) | ^1.0.2 | ✖
[twilio](https://www.npmjs.com/package/twilio) | ^2.11.1 | ✖
[underscore](https://www.npmjs.com/package/underscore) | ^1.8.3 | ✖
[winston](https://www.npmjs.com/package/winston) | ^2.3.0 | ✖
[babel](https://www.npmjs.com/package/babel) | ^6.23.0 | ✔
[babel-cli](https://www.npmjs.com/package/babel-cli) | ^6.3.17 | ✔
[babel-eslint](https://www.npmjs.com/package/babel-eslint) | * | ✔
[babel-plugin-module-alias](https://www.npmjs.com/package/babel-plugin-module-alias) | ^1.6.0 | ✔
[babel-plugin-module-resolver](https://www.npmjs.com/package/babel-plugin-module-resolver) | ^2.7.1 | ✔
[babel-preset-es2015](https://www.npmjs.com/package/babel-preset-es2015) | * | ✔
[babel-preset-stage-0](https://www.npmjs.com/package/babel-preset-stage-0) | ^6.16.0 | ✔
[babel-tape-runner](https://www.npmjs.com/package/babel-tape-runner) | * | ✔
[babel-watch](https://www.npmjs.com/package/babel-watch) | ^2.0.5 | ✔
[babelify](https://www.npmjs.com/package/babelify) | 7.2.0 | ✔
[eslint](https://www.npmjs.com/package/eslint) | * | ✔
[eslint-config-airbnb](https://www.npmjs.com/package/eslint-config-airbnb) | * | ✔
[node-readme](https://www.npmjs.com/package/node-readme) | ^0.1.8 | ✔
[tap-spec](https://www.npmjs.com/package/tap-spec) | ^4.0.2 | ✔
[tape](https://www.npmjs.com/package/tape) | ^4.0.0 | ✔
[zuul](https://www.npmjs.com/package/zuul) | ^3.8.0 | ✔


## Author

Dahquan Hinds <me@dahquan.com> undefined
