# Essential Flash Shield Study

This is a shield study testing the effect of making Flash
click-to-play by default. Still a WIP.

# Setup

Get the necessary tools (assuming you have node.js installed):

```
git clone https://github.com/squarewave/shield-study-essential-flash.git
cd shield-study-essential-flash
npm install

npm install -g shield-study-cli jpm
```

Quick run:

```
shield run . -- -b Nightly
```

Package:

```
jpm xpi .
```
