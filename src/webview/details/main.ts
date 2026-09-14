/**
 * Entry point for the Details panel.
 *
 * Deliberately thin. Runes are a compiler feature of `.svelte` files, so all
 * state lives in `App.svelte`; a `$state()` written here would survive
 * bundling as a call to an undefined global.
 */

import { mount } from "svelte";
import App from "./App.svelte";

mount(App, { target: document.body });
