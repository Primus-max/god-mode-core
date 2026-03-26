Builder result:

```json
{
  "route": "doc_ingest",
  "artifacts": [
    {
      "type": "extraction",
      "sourceArtifactId": "estimate.pdf",
      "fields": [
        {
          "key": "project_name",
          "label": "Project Name",
          "valueType": "string",
          "value": "Main Office Renovation"
        },
        {
          "key": "project_total",
          "label": "Project Total",
          "valueType": "currency",
          "value": "$12,450"
        }
      ],
      "notes": ["Totals verified against summary page."]
    },
    {
      "type": "report",
      "format": "markdown",
      "content": "# Estimate Summary\n\nThe document covers renovation line items and totals.",
      "sections": ["summary", "totals"]
    }
  ]
}
```
