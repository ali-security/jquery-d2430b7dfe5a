#!/usr/bin/env node
/*
 * Headless QUnit runner for the jQuery browser test suite (test/index.html).
 *
 * Drives system Google Chrome through puppeteer-core, waits for QUnit to
 * finish, prints one line per test plus a summary, and exits non-zero when
 * any test fails, no tests ran, a required module ran no tests, or the global
 * timeout is hit.
 *
 * Requirements: modern Node (>= 18) and puppeteer-core resolvable either via
 * NODE_PATH or the QRUNNER_MODULES directory. The page must be served by a
 * PHP-capable HTTP server rooted at the repository root, e.g.:
 *
 *   php -S localhost:8000 -t . &
 *   NODE_PATH=/tmp/qrunner/node_modules node test/runner/run-qunit-headless.js \
 *     [http://localhost:8000/test/index.html]
 *
 * Environment:
 *   CHROME_BIN              Chrome executable (name on PATH or absolute path),
 *                           default "google-chrome-stable"
 *   QRUNNER_MODULES         Directory containing node_modules/puppeteer-core
 *                           (fallback when NODE_PATH is not set)
 *   QUNIT_TIMEOUT_MS        Global timeout, default 20 minutes
 *   QUNIT_REQUIRED_MODULES  Comma-separated modules that must run at least one
 *                           test, default "ajax,attributes,core,support"
 *
 * This file is not part of the jQuery build (listed in .jshintignore; /test is not shipped).
 */
"use strict";

const fs = require( "fs" );
const path = require( "path" );

function loadPuppeteer() {
	try {
		return require( "puppeteer-core" );
	} catch ( e ) {
		const dir = process.env.QRUNNER_MODULES;
		if ( dir ) {
			const candidates = [
				path.join( dir, "puppeteer-core" ),
				path.join( dir, "node_modules", "puppeteer-core" )
			];
			for ( const candidate of candidates ) {
				if ( fs.existsSync( candidate ) ) {
					return require( candidate );
				}
			}
		}
		console.error( "Cannot load puppeteer-core. Set NODE_PATH or QRUNNER_MODULES. " + e.message );
		process.exit( 1 );
	}
}

// puppeteer checks that executablePath exists, so resolve bare names via PATH.
function resolveExecutable( bin ) {
	if ( bin.includes( path.sep ) ) {
		return bin;
	}
	for ( const dir of ( process.env.PATH || "" ).split( path.delimiter ) ) {
		const full = path.join( dir, bin );
		try {
			fs.accessSync( full, fs.constants.X_OK );
			return full;
		} catch ( e ) {
			// keep looking
		}
	}
	return bin;
}

const puppeteer = loadPuppeteer();

const TEST_URL = process.argv[ 2 ] || "http://localhost:8000/test/index.html";
const CHROME_BIN = resolveExecutable( process.env.CHROME_BIN || "google-chrome-stable" );
const GLOBAL_TIMEOUT_MS = Number( process.env.QUNIT_TIMEOUT_MS ) || 20 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const REQUIRED_MODULES = ( process.env.QUNIT_REQUIRED_MODULES === undefined ?
	"ajax,attributes,core,support" : process.env.QUNIT_REQUIRED_MODULES )
	.split( "," ).map( ( s ) => s.trim() ).filter( Boolean );

// Runs in the page (top frame only) before any page script. Hooks QUnit's
// logging callbacks as soon as qunit.js assigns window.QUnit; does not touch
// QUnit.config (testinit.js owns autostart/start).
function installQUnitHook() {
	if ( window.top !== window ) {
		return;
	}
	const results = window.__qunitHeadless = {
		hooked: false,
		tests: [],
		failedAssertions: [],
		done: null
	};

	function dump( value ) {
		let out;
		try {
			out = window.QUnit && window.QUnit.jsDump ?
				window.QUnit.jsDump.parse( value ) : String( value );
		} catch ( e ) {
			out = "<unserializable: " + e + ">";
		}
		out = String( out );
		return out.length > 500 ? out.slice( 0, 500 ) + "..." : out;
	}

	function hook( Q ) {
		if ( results.hooked || !Q || typeof Q.log !== "function" ) {
			return;
		}
		results.hooked = true;
		Q.testStart( function() {
			results.failedAssertions = [];
		} );
		Q.log( function( d ) {
			if ( !d.result ) {
				const entry = { message: String( d.message || "(no message)" ) };
				if ( Object.prototype.hasOwnProperty.call( d, "expected" ) ) {
					entry.expected = dump( d.expected );
					entry.actual = dump( d.actual );
				}
				if ( d.source ) {
					entry.source = String( d.source ).split( "\n" ).slice( 0, 3 ).join( "\n" );
				}
				results.failedAssertions.push( entry );
			}
		} );
		Q.testDone( function( d ) {
			results.tests.push( {
				module: d.module || "",
				name: d.name,
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				duration: d.duration,
				assertions: d.failed ? results.failedAssertions : []
			} );
			results.failedAssertions = [];
		} );
		Q.done( function( d ) {
			results.done = {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			};
		} );
	}

	let value;
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return value;
		},
		set: function( v ) {
			value = v;
			hook( v );
		}
	} );
}

function sleep( ms ) {
	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );
}

function printTest( t ) {
	const status = t.failed > 0 ? "FAIL" : "PASS";
	console.log( status + " " + ( t.module || "(no module)" ) + " :: " + t.name +
		" (" + t.passed + "/" + t.total + ")" );
	if ( t.failed > 0 ) {
		if ( !t.assertions.length ) {
			console.log( "    - " + t.failed + " failed assertion(s), no details captured" );
		}
		for ( const a of t.assertions ) {
			console.log( "    - " + a.message );
			if ( a.expected !== undefined ) {
				console.log( "      expected: " + a.expected );
				console.log( "      actual:   " + a.actual );
			}
			if ( a.source ) {
				console.log( "      " + a.source.split( "\n" ).join( "\n      " ) );
			}
		}
	}
}

async function main() {
	const started = Date.now();
	const allTests = [];
	console.log( "QUnit headless runner: " + TEST_URL + " (chrome: " + CHROME_BIN + ")" );

	const browser = await puppeteer.launch( {
		executablePath: CHROME_BIN,
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--window-size=1280,1024"
		],
		defaultViewport: { width: 1280, height: 1024 }
	} );

	let exitCode = 1;
	try {
		const page = await browser.newPage();
		page.setDefaultTimeout( 0 );

		page.on( "console", ( msg ) => {
			const type = msg.type();
			if ( type === "error" || type === "warn" || type === "warning" || type === "assert" ) {
				console.log( "[browser console." + type + "] " + msg.text() );
			}
		} );
		page.on( "pageerror", ( err ) => {
			console.log( "[browser pageerror] " + ( err && err.message ? err.message : err ) );
		} );
		page.on( "error", ( err ) => {
			console.log( "[browser page crash] " + ( err && err.message ? err.message : err ) );
		} );

		await page.evaluateOnNewDocument( installQUnitHook );

		const response = await page.goto( TEST_URL, { waitUntil: "load", timeout: 120000 } );
		if ( !response || !response.ok() ) {
			throw new Error( "Failed to load " + TEST_URL + ": HTTP " +
				( response ? response.status() : "no response" ) );
		}

		let printed = 0;
		let done = null;
		let hooked = false;
		while ( true ) {
			if ( Date.now() - started > GLOBAL_TIMEOUT_MS ) {
				throw new Error( "Global timeout of " + GLOBAL_TIMEOUT_MS + " ms reached after " +
					printed + " tests" );
			}
			let snapshot;
			try {
				snapshot = await page.evaluate( ( from ) => {
					const r = window.__qunitHeadless;
					return r ? {
						hooked: r.hooked,
						tests: r.tests.slice( from ),
						done: r.done
					} : null;
				}, printed );
			} catch ( e ) {
				// Execution context may be briefly unavailable; retry on next poll.
				console.log( "[runner] poll failed: " + e.message );
				snapshot = null;
			}
			if ( snapshot ) {
				hooked = hooked || snapshot.hooked;
				for ( const t of snapshot.tests ) {
					printTest( t );
				}
				printed += snapshot.tests.length;
				allTests.push( ...snapshot.tests );
				if ( snapshot.done ) {
					done = snapshot.done;
					break;
				}
			}
			await sleep( POLL_INTERVAL_MS );
		}

		if ( !hooked ) {
			throw new Error( "QUnit hook was never installed" );
		}

		const failedTests = allTests.filter( ( t ) => t.failed > 0 ).length;
		const passedTests = allTests.length - failedTests;

		// Per-module breakdown
		const modules = new Map();
		for ( const t of allTests ) {
			const m = modules.get( t.module ) || { tests: 0, failed: 0 };
			m.tests++;
			if ( t.failed > 0 ) {
				m.failed++;
			}
			modules.set( t.module, m );
		}
		console.log( "" );
		console.log( "Per-module results:" );
		for ( const [ name, m ] of modules ) {
			console.log( "  " + ( name || "(no module)" ) + ": " + ( m.tests - m.failed ) +
				" passed, " + m.failed + " failed" );
		}

		const missing = REQUIRED_MODULES.filter( ( m ) => !modules.has( m ) );

		console.log( "" );
		console.log( "QUnit summary: " + allTests.length + " tests, " + done.total + " assertions, " +
			done.passed + " passed, " + done.failed + " failed, " + done.runtime + " ms" );
		console.log( "Tests: " + passedTests + " passed, " + failedTests + " failed" );

		if ( missing.length ) {
			console.log( "ERROR: required module(s) ran no tests: " + missing.join( ", " ) );
		}
		if ( allTests.length === 0 ) {
			console.log( "ERROR: no tests ran" );
		}

		exitCode = ( failedTests > 0 || done.failed > 0 || allTests.length === 0 || missing.length ) ? 1 : 0;
	} catch ( e ) {
		console.log( "ERROR: " + ( e && e.stack ? e.stack : e ) );
		exitCode = 1;
	} finally {
		await Promise.race( [ browser.close().catch( () => {} ), sleep( 10000 ) ] );
	}
	return exitCode;
}

// Hard watchdog in case the page hangs inside page.evaluate/goto.
setTimeout( () => {
	console.log( "ERROR: hard watchdog fired after " + ( GLOBAL_TIMEOUT_MS + 60000 ) + " ms" );
	process.exit( 1 );
}, GLOBAL_TIMEOUT_MS + 60000 );

main().then(
	( code ) => process.exit( code ),
	( e ) => {
		console.log( "ERROR: " + ( e && e.stack ? e.stack : e ) );
		process.exit( 1 );
	}
);
