import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Avatar,
  Button,
  Confirm,
  Field,
  Icon,
  IconButton,
  Notice,
  Segmented,
  Steps,
} from '../src/index.ts';

const html = (node: React.ReactNode) => renderToStaticMarkup(node);

describe('the shared components', () => {
  it('hides a decorative icon from screen readers, and names a labelled one', () => {
    expect(html(<Icon name="home" />)).toContain('aria-hidden="true"');
    const labelled = html(<Icon name="home" label="Home" />);
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('<title>Home</title>');
    expect(labelled).not.toContain('aria-hidden');
  });

  it('gives an icon-only button its label for screen readers and on hover', () => {
    const button = html(<IconButton icon="home" label="Go home" tone="danger" />);
    expect(button).toContain('aria-label="Go home"');
    expect(button).toContain('title="Go home"');
    expect(button).toContain('class="ats-icon-button ats-icon-button--danger"');
    expect(button).toContain('type="button"');
  });

  it('shows a busy button working: a spinner for its icon, and it cannot be pressed again', () => {
    const button = html(
      <Button busy>
        <Icon name="upload" />
        Publishing…
      </Button>,
    );
    expect(button).toContain('ats-button--busy');
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain('class="ats-spinner"');
    expect(html(<Button>Publish</Button>)).not.toContain('aria-busy');
    const icon = html(<IconButton icon="refresh" label="Look again" busy />);
    expect(icon).toContain('class="ats-spinner"');
    expect(icon).not.toContain('<svg');
    expect(icon).toContain('disabled=""');
  });

  it('shows up to two initials, or a question mark for no name', () => {
    expect(html(<Avatar name="sam o'neill extra" color="#123456" />)).toContain('>SO<');
    expect(html(<Avatar name="  " color="#123456" />)).toContain('>?<');
  });

  it("ties a field's label, hint and error to its input", () => {
    const field = html(<Field label="Email" hint="We never share it" error="Not an address" />);
    const id = /<input id="([^"]+)"/.exec(field)?.[1];
    expect(id).toBeTruthy();
    expect(field).toContain(`<label for="${id}">Email</label>`);
    expect(field).toContain(`aria-describedby="${id}-hint"`);
    expect(field).toContain('aria-invalid="true"');
    expect(field).toContain('Not an address');
    expect(html(<Field label="Name" />)).not.toMatch(/aria-(describedby|invalid)/);
  });

  it('announces errors at once, and other notices politely', () => {
    expect(html(<Notice tone="error">No</Notice>)).toContain('role="alert"');
    expect(html(<Notice>Saved</Notice>)).toContain('role="status"');
  });

  it('says which step this is, counting from one', () => {
    const steps = html(<Steps total={3} current={1} />);
    expect(steps).toContain('aria-label="Step 2 of 3"');
    expect(steps.match(/data-done="true"/g)).toHaveLength(2);
  });

  it('makes a confirmation wait while it works', () => {
    const noop = () => {};
    const idle = html(
      <Confirm confirm="Remove" onConfirm={noop} onCancel={noop}>
        Remove Sam?
      </Confirm>,
    );
    expect(idle).toContain('role="alertdialog"');
    expect(idle).toContain('>Remove</button>');
    const busy = html(
      <Confirm confirm="Remove" onConfirm={noop} onCancel={noop} busy>
        Remove Sam?
      </Confirm>,
    );
    expect(busy).toContain('disabled=""');
    expect(busy).toContain('Working…');
  });

  it('marks the chosen option of a segmented choice, all in one radio group', () => {
    const choice = html(
      <Segmented
        label="Size"
        value="m"
        onChange={() => {}}
        options={[
          { value: 's', label: 'Small' },
          { value: 'm', label: 'Medium' },
        ]}
      />,
    );
    expect(choice).toContain('<legend class="visually-hidden">Size</legend>');
    expect(choice.match(/checked=""/g)).toHaveLength(1);
    expect(/<input[^>]*checked=""[^>]*>/.exec(choice)?.[0]).toContain('value="m"');
    expect(new Set(choice.match(/name="[^"]+"/g)).size).toBe(1);
  });
});
