# LSP Navigation Logging Implementation

## Summary

Detailed logging has been added for all LSP navigation requests to help monitor and debug "Go to Definition", "Find References", and related features in the Smart Indexer extension.

## Implementation Details

### Client-Side Logging (src/extension.ts)

**Already Implemented:**
- ✅ `LogOutputChannel` created with log level support
- ✅ Middleware for `provideDefinition` and `provideReferences`
- ✅ Logs request parameters (file path, line, character)
- ✅ Logs response data (number of locations, duration)
- ✅ Error handling with timing information

**Middleware Features:**
- Logs file path and position for each request
- Measures and logs execution time
- Counts and logs number of results returned
- Catches and logs errors with timing

### Server-Side Logging (server/src/server.ts)

**Newly Implemented:**

1. **onDefinition Handler**
   - Logs: URI, position (line:character)
   - Logs: Symbol name being searched
   - Logs: Number of locations found
   - Logs: Execution time in milliseconds
   - Error logging with timing

2. **onReferences Handler**
   - Logs: URI, position (line:character)
   - Logs: Symbol name being searched
   - Logs: Number of references found
   - Logs: Execution time in milliseconds
   - Error logging with timing

3. **onWorkspaceSymbol Handler**
   - Logs: Search query
   - Logs: Number of symbols returned
   - Logs: Execution time in milliseconds
   - Error logging with timing

4. **onCompletion Handler**
   - Logs: URI, position (line:character)
   - Logs: Completion prefix
   - Logs: Number of completion items
   - Logs: Execution time in milliseconds
   - Error logging with timing

## Log Format

### Client-Side
```
[Client] Definition request: /path/to/file.ts:10:5
[Client] Definition response: 3 locations, 45 ms
```

### Server-Side
```
[Server] Definition request: /path/to/file.ts:10:5
[Server] Definition result: symbol="MyClass", 3 locations in 42 ms
```

## Usage

1. **Build the extension:**
   ```bash
   npm run build
   ```

2. **Run Extension Development Host:**
   - Press `F5` in VS Code
   - Or use "Run > Start Debugging"

3. **View Logs:**
   - Open "Smart Indexer" output channel
   - View > Output > Select "Smart Indexer" from dropdown

4. **Test Navigation:**
   - Use "Go to Definition" (F12) on any symbol
   - Use "Find References" (Shift+F12) on any symbol
   - Use "Go to Symbol in Workspace" (Ctrl+T / Cmd+T)
   - Trigger code completion (Ctrl+Space)

5. **Observe Logs:**
   - Each action produces paired client/server log entries
   - Check timing information for performance analysis
   - Monitor result counts to verify index accuracy

## Log Level Control

The logging respects VS Code's log level settings:
- **Developer: Set Log Level** command
- Levels: Trace, Debug, Info, Warning, Error, Off
- Currently using `info` level for main events
- Use `debug` for more verbose logging (future enhancement)

## Benefits

1. **Debugging**: Quickly identify which LSP requests are being made
2. **Performance**: Monitor response times for optimization
3. **Accuracy**: Verify correct number of results returned
4. **Troubleshooting**: Error messages include timing and context
5. **Development**: Understand extension behavior during testing

## Example Log Output

```
[Client] Extension activating...
[Client] Workspace folders: /Users/dev/project
[Client] Starting language client...
[Server] ========== INITIALIZATION START ==========
[Server] VS Code version: Visual Studio Code 1.85.0
[Server] Selected workspace root: /Users/dev/project
[Server] ========== INITIALIZATION COMPLETE ==========
[Client] Language client started successfully

[Client] Definition request: /Users/dev/project/src/index.ts:25:10
[Server] Definition request: /Users/dev/project/src/index.ts:25:10
[Server] Definition result: symbol="MyClass", 1 locations in 12 ms
[Client] Definition response: 1 locations, 15 ms

[Client] References request: /Users/dev/project/src/index.ts:25:10
[Server] References request: /Users/dev/project/src/index.ts:25:10
[Server] References result: symbol="MyClass", 5 locations in 8 ms
[Client] References response: 5 locations, 11 ms
```

## Future Enhancements

- Add configurable log verbosity levels
- Include file type and language in logs
- Add statistics aggregation (average response time, etc.)
- Support for structured logging with separate debug channel
