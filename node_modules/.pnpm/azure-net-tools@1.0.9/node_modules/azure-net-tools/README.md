# 🔧 azure-net-tools

**A collection of universal utilities.**
Ideal for TypeScript/JavaScript projects, covering a wide range of tasks: object and string manipulation, DOM observation, event bus logic, and more.

## 📦 Installation

```bash
npm install azure-net-tools
```

## 🧩 Utilities

> All utilities can be imported directly from the package.

### 🧠 `EnvironmentUtil`

Detects the current execution environment:

* `EnvironmentUtil.isBrowser`
* `EnvironmentUtil.isServer`
* `EnvironmentUtil.isWebWorker`
* `EnvironmentUtil.currentEnvironment()` → `'browser' | 'server' | 'webWorker' | 'unknown'`

---

### 💾 `DownloadUtil`

Triggers file download in the browser:

```ts
DownloadUtil.download('https://example.com/file.pdf', 'myFile.pdf');
```

---

### 📡 `EventBus<D>`

A lightweight event bus implementation.

```ts
const bus = new EventBus<'loaded' | 'error'>();

bus.subscribe('loaded', (data) => console.log('Loaded:', data));
bus.publish('loaded', { status: 'ok' });
```

---

### 👀 `IntersectionObserverUtil<T>`

Simplified wrapper for `IntersectionObserver`.

```ts
const observer = new IntersectionObserverUtil(element, {
	callback(entry) {
		console.log('Element is visible:', entry);
	},
	once: true
});
```

---

### ✍️ `TextUtil`

String utilities:

* `formatText(number, ['one', 'few', 'many'])` — pluralization.
* `truncate('long text...', 10)`
* `capitalize('hello')` → `'Hello'`
* `decapitalize('Hello')` → `'hello'`
* `isEmptyOrWhitespace('   ')` → `true`

---

### 🧱 `ObjectUtil`

Object utilities:

* `clone(obj)` — shallow clone.
* `deepClone(obj, structured = false)` — deep clone (via `structuredClone` or JSON).
* `compareAsString(obj1, obj2)` — compares objects via their stringified forms.
* `equals(obj1, obj2)` — deep equality check (supports functions).
* `isAllKeysEmpty(obj)` — checks if all properties are `null` or `undefined`.
* `isObjectEmpty(obj)` — checks if object has no keys.
* `renderAsString(obj)` — HTML-highlighted JSON representation.

---

### 📊 `FormDataUtil`

Utility class for converting between `FormData` and deeply nested JavaScript objects, supporting complex structures including arrays, nested objects, Maps, Sets, Dates, and Blob/File objects.

- Converts `FormData` keys with bracket notation (e.g., `foo[bar][baz]`) into nested objects.
- Supports serialization of objects with nested structures into `FormData`.
- Detects cyclic references during serialization and throws an error.
- Handles special types like `Date`, `Blob`, `File`, `Map`, and `Set`.

#### Example usage

```ts
import { FormDataUtil } from 'azure-net-tools';

// Convert FormData to object
const formData = new FormData();
formData.append('user[name]', 'Alice');
formData.append('user[age]', '30');
const obj = FormDataUtil.toObject<{ user: { name: string; age: string } }>(formData);
console.log(obj.user.name); // Alice

// Convert object to FormData
const objToSerialize = {
	user: {
		name: 'Bob',
		age: 25,
		files: [new File(['content'], 'file.txt')],
		birthDate: new Date('1995-12-17')
	}
};
const fd = FormDataUtil.fromObject(objToSerialize);
```

---

### 📅 `DateUtil`

The `DateUtil` class offers helper methods to format and manipulate dates and times, including support for different locales.

### Features

* Global locale setting (`en`, `ru`, and custom).
* Flexible date and time formatting.
* Locale-aware month name rendering.
* Custom formatting with tokens (`yyyy`, `MM`, `dd`, `HH`, etc.).
* Optional UTC or local time formatting.

### Example Usage

```ts
DateUtil.setLocale('en'); // or 'ru' or custom

DateUtil.toDate('2025-05-23'); // "23.05.2025"
DateUtil.toDateTime(new Date()); // "23.05.2025 14:32"
DateUtil.toDayMonth('2025-08-15'); // "15 August" (locale-aware)
DateUtil.toFormat('2025-12-01', 'dd MM yyyy'); // "01 December 2025"
```

### Supported Format Tokens

| Token  | Description                    |
| ------ | ------------------------------ |
| `yyyy` | Full year (e.g., `2025`)       |
| `yy`   | Short year (e.g., `25`)        |
| `MM`   | Month name from locale         |
| `mm`   | Month number with leading zero |
| `dd`   | Day with leading zero          |
| `d`    | Day without leading zero       |
| `HH`   | Hours with leading zero        |
| `ii`   | Minutes with leading zero      |
| `ss`   | Seconds with leading zero      |

---

### 🍪 `Cookies`

The `Cookies` class provides a simple interface for interacting with cookies in the browser.

### Features

* Set, get, delete, and clear cookies.
* Supports JSON-serializable values.
* Custom options (expiration, path, domain, secure, SameSite).
* Auto-check for browser environment.

### Example Usage

```ts
Cookies.set('theme', 'dark', { expires: 7 }); // expires in 7 days
const theme = Cookies.get('theme'); // "dark"

Cookies.set('user', { name: 'Alice' });
const user = Cookies.get<{ name: string }>('user'); // { name: 'Alice' }

Cookies.delete('theme');
```

---


## 📘 Usage Example

```ts
import { EnvironmentUtil, TextUtil, ObjectUtil } from 'azure-net-tools';

if (EnvironmentUtil.isBrowser) {
	console.log(TextUtil.capitalize('hello world'));
}
```

---

## 📄 License

MIT
